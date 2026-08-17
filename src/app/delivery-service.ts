import type { DeliveryRepository } from "../delivery/repository.ts";
import type { Delivery, DeliveryStatus, PageCursor } from "../domain/types.ts";
import { AppError } from "./errors.ts";
import { type Page, pageResult } from "./pagination.ts";
import type { DeliveryService as DeliveryServiceContract } from "./types.ts";

const DEFAULT_LIST_LIMIT = 100;
const MAXIMUM_LIST_LIMIT = 500;

function requireLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_LIST_LIMIT) {
    throw new AppError(
      "validation",
      "invalid_limit",
      `limit must be an integer between 1 and ${MAXIMUM_LIST_LIMIT}`,
    );
  }
  return limit;
}

export class DefaultDeliveryService implements DeliveryServiceContract {
  constructor(private readonly deliveries: DeliveryRepository) {}

  list(status?: DeliveryStatus, limit = DEFAULT_LIST_LIMIT) {
    return this.deliveries.list(status, requireLimit(limit));
  }

  listPage(
    status?: DeliveryStatus,
    limit = DEFAULT_LIST_LIMIT,
    cursor?: PageCursor,
  ): Page<Delivery> {
    const result = this.deliveries.listPage(status, requireLimit(limit), cursor);
    return pageResult(result.items, result.hasMore, (item) => ({
      timestamp: item.createdAt,
      id: item.id,
    }));
  }

  retry(id: string) {
    const deliveryId = id.trim();
    if (!deliveryId) {
      throw new AppError("validation", "invalid_delivery_id", "Delivery ID must not be empty");
    }
    if (!this.deliveries.findById(deliveryId)) {
      throw new AppError("not_found", "delivery_not_found", "Delivery not found");
    }
    try {
      return this.deliveries.retry(deliveryId);
    } catch (error) {
      throw new AppError(
        "conflict",
        "delivery_not_retryable",
        "Delivery is not retryable",
        undefined,
        { cause: error },
      );
    }
  }
}
