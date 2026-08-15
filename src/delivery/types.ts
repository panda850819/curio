import type {
  Delivery,
  DeliveryStatus,
  Item,
  PollFailureEvent,
  Subscription,
} from "../domain/types.ts";

export interface TelegramDestinationConfig {
  chatId: string;
}

export interface DeliveryPayload {
  delivery: Delivery;
  chatId: string;
  item: Item | null;
  failureEvent: PollFailureEvent | null;
  subscription: Subscription;
}

export interface DeliveryCompletion {
  deliveryId: string;
  outcome: "delivered" | "retry" | "uncertain" | "permanent_failure";
  startedAt: number;
  finishedAt: number;
  httpStatus?: number | null;
  error?: string | null;
  telegramMessageId?: number | null;
  nextAttemptAt?: number | null;
}

export const DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  "pending",
  "processing",
  "retry_scheduled",
  "delivered",
  "uncertain",
  "permanent_failure",
];
