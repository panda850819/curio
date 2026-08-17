import type { SubscriptionRepository } from "../db/repositories.ts";
import type { DestinationRepository } from "../db/routing-repositories.ts";
import { DuplicateRouteError, type RouteRepository } from "../db/routing-repositories.ts";
import type { JsonValue, NewRoute, PageCursor, Route } from "../domain/types.ts";
import { AppError } from "./errors.ts";
import { type Page, pageResult } from "./pagination.ts";
import type { RouteService as RouteServiceContract } from "./types.ts";

export class DefaultRouteService implements RouteServiceContract {
  constructor(
    private readonly routes: RouteRepository,
    private readonly subscriptions?: SubscriptionRepository,
    private readonly destinations?: DestinationRepository,
  ) {}

  listPage(limit = 100, subscriptionId?: string, cursor?: PageCursor): Page<Route> {
    if (subscriptionId !== undefined) this.requireSubscription(subscriptionId);
    const result = subscriptionId
      ? this.routes.listPageBySubscription(subscriptionId, limit, cursor)
      : this.routes.listPage(limit, cursor);
    return pageResult(result.items, result.hasMore, (item) => ({
      timestamp: item.createdAt,
      id: item.id,
    }));
  }

  get(id: string): Route {
    const route = this.routes.findById(id);
    if (!route) throw new AppError("not_found", "route_not_found", "Route not found");
    return route;
  }

  create(input: NewRoute): Route {
    this.requireSubscription(input.subscriptionId);
    this.requireDestination(input.destinationId);
    try {
      return this.routes.create(input);
    } catch (error) {
      if (error instanceof DuplicateRouteError) {
        throw new AppError("conflict", "route_exists", error.message, undefined, {
          cause: error,
        });
      }
      throw error;
    }
  }

  update(id: string, input: { enabled?: boolean; config?: JsonValue }): Route {
    this.get(id);
    const route = this.routes.update(id, input);
    if (!route) throw new AppError("not_found", "route_not_found", "Route not found");
    return route;
  }

  remove(id: string): { id: string } {
    const route = this.get(id);
    if (!this.routes.delete(route.id)) {
      throw new AppError("not_found", "route_not_found", "Route not found");
    }
    return { id: route.id };
  }

  private requireSubscription(id: string): void {
    if (this.subscriptions && !this.subscriptions.findById(id)) {
      throw new AppError("not_found", "subscription_not_found", "Subscription not found");
    }
  }

  private requireDestination(id: string): void {
    if (this.destinations && !this.destinations.findById(id)) {
      throw new AppError("not_found", "destination_not_found", "Destination not found");
    }
  }
}
