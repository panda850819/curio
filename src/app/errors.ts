import { DuplicateSubscriptionError } from "../db/repositories.ts";
import { DuplicateDestinationError, DuplicateRouteError } from "../db/routing-repositories.ts";
import { ProbeError } from "../probe/errors.ts";
import { PollAlreadyRunningError, PollCoordinatorStoppedError } from "../scheduler.ts";
import { sanitizeErrorMessage } from "../security/redaction.ts";

export type AppErrorKind = "validation" | "not_found" | "conflict" | "unexpected";

export class AppError extends Error {
  constructor(
    readonly kind: AppErrorKind,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AppError";
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ProbeError) {
    return new AppError("validation", error.code, sanitizeErrorMessage(error), undefined, {
      cause: error,
    });
  }
  if (error instanceof DuplicateSubscriptionError) {
    return new AppError("conflict", "subscription_exists", error.message, undefined, {
      cause: error,
    });
  }
  if (error instanceof DuplicateDestinationError) {
    return new AppError("conflict", "destination_exists", error.message, undefined, {
      cause: error,
    });
  }
  if (error instanceof DuplicateRouteError) {
    return new AppError("conflict", "route_exists", error.message, undefined, { cause: error });
  }
  if (error instanceof PollAlreadyRunningError) {
    return new AppError("conflict", "poll_in_progress", error.message, undefined, {
      cause: error,
    });
  }
  if (error instanceof PollCoordinatorStoppedError) {
    return new AppError("conflict", "poll_coordinator_stopped", error.message, undefined, {
      cause: error,
    });
  }
  return new AppError("unexpected", "internal_error", "Internal server error", undefined, {
    cause: error,
  });
}

export function statusForAppError(error: AppError): number {
  if (error.code === "method_not_allowed") return 405;
  switch (error.kind) {
    case "validation":
      return 400;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "unexpected":
      return 500;
  }
}
