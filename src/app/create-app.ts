import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { TelegramBotRepository } from "../bot/repository.ts";
import type { Config } from "../config.ts";
import { openDatabase } from "../db/database.ts";
import { migrate } from "../db/migrations.ts";
import { ItemRepository, SubscriptionRepository } from "../db/repositories.ts";
import { DestinationRepository, RouteRepository } from "../db/routing-repositories.ts";
import { DeliveryRepository } from "../delivery/repository.ts";
import type { TelegramTransport } from "../delivery/telegram.ts";
import { SafeHttpClient, SystemResolver } from "../probe/index.ts";
import type { ProbeHttpClient } from "../probe/types.ts";
import { PollCoordinator, PollScheduler, type SourcePoller } from "../scheduler.ts";
import { HtmlSourceAdapter } from "../sources/html/adapter.ts";
import { SourceRouter } from "../sources/router.ts";
import { RssSourceAdapter } from "../sources/rss/index.ts";
import { XSourceAdapter } from "../sources/x/adapter.ts";
import { ProcessXbirdClient } from "../sources/x/client.ts";
import type { XbirdTimelineClient } from "../sources/x/types.ts";
import { YoutubeSourceAdapter } from "../sources/youtube/adapter.ts";
import { DefaultDeliveryService } from "./delivery-service.ts";
import { DefaultDestinationService } from "./destination-service.ts";
import { DefaultProbeService } from "./probe-service.ts";
import { DefaultRouteService } from "./route-service.ts";
import { DefaultSubscriptionService } from "./subscription-service.ts";
import type { ApplicationServices } from "./types.ts";

const DEFAULT_MIGRATIONS_PATH = resolve(import.meta.dir, "../../migrations");

export interface CreateAppOptions {
  database?: Database;
  databasePath?: string;
  migrationsPath?: string;
  x?: Config["x"];
  telegram?: Config["telegram"];
  telegramTransport?: TelegramTransport;
  probeClient?: ProbeHttpClient;
  xClient?: XbirdTimelineClient;
  sourcePollers?: Partial<Record<string, SourcePoller>>;
  now?: () => number;
}

export interface CurioApplication {
  readonly services: ApplicationServices;
  readonly coordinator: PollCoordinator;
  readonly scheduler: PollScheduler;
  readonly deliveryRepository: DeliveryRepository;
  readonly destinationRepository: DestinationRepository;
  readonly routeRepository: RouteRepository;
  readonly telegramBotRepository: TelegramBotRepository;
  readonly appliedMigrations: number;
  close(): void;
}

function createXClient(options: CreateAppOptions): XbirdTimelineClient {
  if (options.xClient) return options.xClient;
  if (options.x) return new ProcessXbirdClient(options.x.authToken, options.x.ct0);
  return {
    userTweets: async () => {
      throw new Error("X credentials are not configured");
    },
  };
}

export function createApp(options: CreateAppOptions = {}): CurioApplication {
  const database = options.database ?? openDatabase(options.databasePath ?? "./data/curio.db");
  const ownsDatabase = options.database === undefined;
  const appliedMigrations = migrate(database, options.migrationsPath ?? DEFAULT_MIGRATIONS_PATH);
  const now = options.now ?? Date.now;

  const destinations = new DestinationRepository(database, undefined, now);
  const routes = new RouteRepository(database, undefined, now);
  const subscriptions = new SubscriptionRepository(database, undefined, now, routes);
  const items = new ItemRepository(database);
  const deliveries = new DeliveryRepository(database, undefined, now, destinations, routes);
  const telegramBotRepository = new TelegramBotRepository(database, now);
  const probeClient = options.probeClient ?? new SafeHttpClient(new SystemResolver());
  const rssAdapter = new RssSourceAdapter(probeClient, subscriptions, items, now);
  const htmlAdapter = new HtmlSourceAdapter(probeClient, subscriptions, items, now);
  const youtubeAdapter = new YoutubeSourceAdapter(probeClient, subscriptions, items, now);
  const xAdapter = new XSourceAdapter(createXClient(options), subscriptions, items, now);
  const pollers: Record<string, SourcePoller> = {
    html: options.sourcePollers?.html ?? htmlAdapter,
    rss: options.sourcePollers?.rss ?? rssAdapter,
    x: options.sourcePollers?.x ?? xAdapter,
    youtube: options.sourcePollers?.youtube ?? youtubeAdapter,
  };
  const router = new SourceRouter(subscriptions, pollers);
  const coordinator = new PollCoordinator(router);
  const scheduler = new PollScheduler(subscriptions, coordinator, now);
  const probeService = new DefaultProbeService(probeClient);

  const services: ApplicationServices = {
    probe: probeService,
    subscriptions: new DefaultSubscriptionService(
      subscriptions,
      coordinator,
      now,
      probeService,
      items,
    ),
    destinations: new DefaultDestinationService(
      destinations,
      options.telegram,
      options.telegramTransport,
    ),
    routes: new DefaultRouteService(routes, subscriptions, destinations),
    deliveries: new DefaultDeliveryService(deliveries),
  };

  let closed = false;
  return {
    services,
    coordinator,
    scheduler,
    deliveryRepository: deliveries,
    destinationRepository: destinations,
    routeRepository: routes,
    telegramBotRepository,
    appliedMigrations,
    close() {
      if (closed || !ownsDatabase) return;
      closed = true;
      database.close();
    },
  };
}
