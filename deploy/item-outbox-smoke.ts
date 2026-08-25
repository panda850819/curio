import { openDatabase } from "../app/src/db/database.ts";
import { ItemRepository, SubscriptionRepository } from "../app/src/db/repositories.ts";
import { DestinationRepository, RouteRepository } from "../app/src/db/routing-repositories.ts";

const databasePath = process.env.DATABASE_PATH || "/data/curio.db";
const database = openDatabase(databasePath);
const marker = `deployment-smoke-${Date.now()}`;
let verified = false;
try {
  const smoke = database.transaction(() => {
    const subscriptions = new SubscriptionRepository(database);
    const items = new ItemRepository(database);
    const destination = new DestinationRepository(database).list().find((entry) => entry.enabled);
    if (!destination) throw new Error("Expected an enabled destination for outbox smoke");
    const subscription = subscriptions.create({
      adapter: "rss",
      sourceKey: marker,
      sourceUrl: `https://example.com/${marker}.xml`,
      nextPollAt: null,
    });
    new RouteRepository(database).create({
      subscriptionId: subscription.id,
      destinationId: destination.id,
    });
    items.recordPoll({
      subscriptionId: subscription.id,
      items: [{ externalId: marker, title: "Deployment outbox smoke" }],
      cursor: {},
      polledAt: Date.now(),
    });
    const count = database
      .query<{ count: number }, [string]>(
        `SELECT count(*) AS count FROM deliveries
         WHERE item_id IN (SELECT id FROM items WHERE external_id = ?)
           AND status = 'pending'`,
      )
      .get(marker)?.count;
    if (count !== 1) throw new Error(`Expected one pending delivery, received ${count ?? 0}`);
    verified = true;
    throw new Error("ROLLBACK_SMOKE");
  });
  smoke();
} catch (error) {
  if (!(error instanceof Error) || error.message !== "ROLLBACK_SMOKE" || !verified) throw error;
} finally {
  database.close();
}
console.log(JSON.stringify({ status: "ok", check: "item_outbox", rolledBack: true }));
