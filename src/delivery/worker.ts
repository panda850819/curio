import type { DeliveryRepository } from "./repository.ts";
import type { TelegramDestinationAdapter, TelegramSendResult } from "./telegram.ts";

const RETRY_DELAYS = [60_000, 300_000, 1_800_000, 7_200_000] as const;

export type DeliveryWorkerSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;
function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export class DeliveryWorker {
  private stopping = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly repository: DeliveryRepository,
    private readonly adapter: TelegramDestinationAdapter,
    private readonly now: () => number = Date.now,
    private readonly sleep: DeliveryWorkerSleep = defaultSleep,
    private readonly log: (event: Record<string, unknown>) => void = (event) =>
      console.log(JSON.stringify(event)),
    private readonly concurrency = 4,
    private readonly idleMilliseconds = 1_000,
  ) {}

  private completion(
    deliveryId: string,
    attempt: number,
    startedAt: number,
    result: TelegramSendResult,
  ) {
    const finishedAt = this.now();
    if (result.outcome === "delivered") {
      return {
        deliveryId,
        outcome: result.outcome,
        telegramMessageId: result.messageId,
        httpStatus: result.httpStatus,
        startedAt,
        finishedAt,
      } as const;
    }
    if (result.outcome === "uncertain" || result.outcome === "permanent_failure") {
      return {
        deliveryId,
        outcome: result.outcome,
        error: result.error,
        httpStatus: result.httpStatus,
        startedAt,
        finishedAt,
      } as const;
    }
    if (attempt >= 5) {
      return {
        deliveryId,
        outcome: "permanent_failure",
        error: result.error,
        httpStatus: result.httpStatus,
        startedAt,
        finishedAt,
      } as const;
    }
    const delay = result.retryAfterSeconds
      ? result.retryAfterSeconds * 1_000
      : (RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)] ?? 7_200_000);
    return {
      deliveryId,
      outcome: "retry",
      error: result.error,
      httpStatus: result.httpStatus,
      nextAttemptAt: finishedAt + delay,
      startedAt,
      finishedAt,
    } as const;
  }

  private async process(deliveryId: string, attempt: number): Promise<void> {
    const startedAt = this.now();
    let sendStarted = false;
    try {
      const payload = this.repository.loadPayload(deliveryId);
      sendStarted = true;
      const result = await this.adapter.send(payload);
      const completion = this.completion(deliveryId, attempt, startedAt, result);
      try {
        this.repository.complete(completion);
      } catch (error) {
        if (result.outcome !== "delivered") throw error;
        this.repository.complete({
          deliveryId,
          outcome: "uncertain",
          error: "Telegram acknowledged delivery but persistence failed",
          httpStatus: result.httpStatus,
          startedAt,
          finishedAt: this.now(),
        });
      }
    } catch (error) {
      try {
        this.repository.complete({
          deliveryId,
          outcome: sendStarted ? "uncertain" : "permanent_failure",
          error: sendStarted
            ? "Delivery failed after the send operation started"
            : "Delivery payload could not be loaded",
          startedAt,
          finishedAt: this.now(),
        });
      } catch {
        // A database outage can prevent both completion paths; startup recovery handles processing rows.
      }
      this.log({
        level: "error",
        message: "delivery_processing_failed",
        deliveryId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  async tick(): Promise<number> {
    if (this.stopping) return 0;
    const claimed = this.repository.claimDue(this.concurrency);
    const operations = claimed.map((delivery) => {
      const operation = this.process(delivery.id, delivery.attemptCount);
      this.inFlight.add(operation);
      void operation.finally(() => this.inFlight.delete(operation));
      return operation;
    });
    await Promise.allSettled(operations);
    return claimed.length;
  }

  async run(signal: AbortSignal): Promise<void> {
    this.repository.recoverProcessing();
    while (!this.stopping && !signal.aborted) {
      try {
        await this.tick();
      } catch (error) {
        this.log({
          level: "error",
          message: "delivery_worker_tick_failed",
          error: error instanceof Error ? error.name : "UnknownError",
        });
      }
      if (!this.stopping && !signal.aborted) await this.sleep(this.idleMilliseconds, signal);
    }
    await this.waitForIdle();
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    await this.waitForIdle();
  }
}
