import type { SubscriptionRepository } from "./db/repositories.ts";
export class PollAlreadyRunningError extends Error {
  constructor(subscriptionId: string) {
    super(`Poll already running: ${subscriptionId}`);
    this.name = "PollAlreadyRunningError";
  }
}

export class PollCoordinatorStoppedError extends Error {
  constructor() {
    super("Poll coordinator is stopping");
    this.name = "PollCoordinatorStoppedError";
  }
}

export interface SourcePollResult {
  status: string;
  insertedItems: number;
  duplicateItems: number;
}

export interface SourcePoller {
  poll(subscriptionId: string): Promise<SourcePollResult>;
}

export class PollCoordinator {
  private readonly inFlight = new Map<string, Promise<SourcePollResult>>();
  private accepting = true;

  constructor(private readonly poller: SourcePoller) {}

  poll(subscriptionId: string): Promise<SourcePollResult> {
    if (!this.accepting) return Promise.reject(new PollCoordinatorStoppedError());
    if (this.inFlight.has(subscriptionId)) {
      return Promise.reject(new PollAlreadyRunningError(subscriptionId));
    }
    const operation = this.poller.poll(subscriptionId);
    this.inFlight.set(subscriptionId, operation);
    void operation.then(
      () => this.inFlight.delete(subscriptionId),
      () => this.inFlight.delete(subscriptionId),
    );
    return operation;
  }

  isPolling(subscriptionId: string): boolean {
    return this.inFlight.has(subscriptionId);
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()]);
  }

  async stop(): Promise<void> {
    this.accepting = false;
    await this.waitForIdle();
  }
}

export type SchedulerSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

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

export interface SchedulerEvent {
  level: "info" | "error";
  message: string;
  subscriptionId?: string;
  error?: string;
}

export class PollScheduler {
  private stopping = false;

  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly coordinator: PollCoordinator,
    private readonly now: () => number = Date.now,
    private readonly sleep: SchedulerSleep = defaultSleep,
    private readonly log: (event: SchedulerEvent) => void = (event) =>
      console.log(JSON.stringify(event)),
    private readonly concurrency = 4,
    private readonly idleMilliseconds = 1_000,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("Scheduler concurrency must be a positive integer");
    }
  }

  async tick(): Promise<number> {
    if (this.stopping) return 0;
    const due = this.subscriptions
      .listDue(this.now(), this.concurrency)
      .filter((subscription) => !this.coordinator.isPolling(subscription.id));

    await Promise.allSettled(
      due.map(async (subscription) => {
        try {
          await this.coordinator.poll(subscription.id);
        } catch (error) {
          this.log({
            level: "error",
            message: "subscription_poll_failed",
            subscriptionId: subscription.id,
            error: error instanceof Error ? error.name : "UnknownError",
          });
        }
      }),
    );
    return due.length;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!this.stopping && !signal.aborted) {
      try {
        await this.tick();
      } catch (error) {
        this.log({
          level: "error",
          message: "scheduler_tick_failed",
          error: error instanceof Error ? error.name : "UnknownError",
        });
      }
      if (!this.stopping && !signal.aborted) await this.sleep(this.idleMilliseconds, signal);
    }
    await this.coordinator.waitForIdle();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.coordinator.stop();
  }
}
