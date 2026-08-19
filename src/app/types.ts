import type { TelegramChatMetadata } from "../delivery/telegram.ts";
import type {
  Delivery,
  DeliveryStatus,
  Destination,
  DestinationUpdate,
  Item,
  JsonValue,
  NewDestination,
  NewRoute,
  PageCursor,
  Route,
  Subscription,
  SubscriptionUpdate,
} from "../domain/types.ts";
import type { ProbeResult, SubscriptionCandidate } from "../probe/types.ts";
import type { SourcePollResult } from "../scheduler.ts";
import type { EmailInbox } from "../sources/email/types.ts";
import type { Page } from "./pagination.ts";

export interface ProbeService {
  probe(inputUrl: string): Promise<ProbeResult>;
}

export interface EmailInboxService {
  get(): EmailInbox | null;
}

export interface FollowInput {
  candidate: SubscriptionCandidate;
  intervalMinutes: number;
  metadata?: JsonValue;
}

export interface FollowResult {
  subscription: Subscription;
  disposition: "created" | "existing";
}

export interface SubscriptionService {
  follow(input: FollowInput): FollowResult;
  list(limit?: number): Subscription[];
  listPage(limit?: number, cursor?: PageCursor): Page<Subscription>;
  followVerified(input: FollowInput): Promise<FollowResult>;
  get(id: string): Subscription;
  resolve(target: string): Subscription;
  pause(id: string): Subscription;
  resume(id: string): Subscription;
  remove(id: string): { id: string };
  update(id: string, input: SubscriptionUpdate): Subscription;
  listItemsPage(limit?: number, subscriptionId?: string, cursor?: PageCursor): Page<Item>;
  poll(id: string): Promise<SourcePollResult>;
}

export interface DestinationVerification {
  destinationId: string;
  chat: TelegramChatMetadata;
}

export interface DestinationService {
  listPage(limit?: number, cursor?: PageCursor): Page<Destination>;
  get(id: string): Destination;
  create(input: NewDestination): Destination;
  update(id: string, input: DestinationUpdate): Destination;
  verify(id: string): Promise<DestinationVerification>;
}

export interface RouteService {
  listPage(limit?: number, subscriptionId?: string, cursor?: PageCursor): Page<Route>;
  get(id: string): Route;
  create(input: NewRoute): Route;
  update(id: string, input: { enabled?: boolean; config?: JsonValue }): Route;
  remove(id: string): { id: string };
}

export interface DeliveryService {
  list(status?: DeliveryStatus, limit?: number): Delivery[];
  listPage(status?: DeliveryStatus, limit?: number, cursor?: PageCursor): Page<Delivery>;
  retry(id: string): Delivery;
}

export interface ApplicationServices {
  probe: ProbeService;
  email: EmailInboxService;
  subscriptions: SubscriptionService;
  destinations: DestinationService;
  routes: RouteService;
  deliveries: DeliveryService;
}
