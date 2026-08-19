#!/usr/bin/env bun
import { createApp } from "./app/create-app.ts";
import { AppError } from "./app/errors.ts";
import type { ApplicationServices } from "./app/types.ts";
import { DELIVERY_STATUSES } from "./delivery/types.ts";
import type { Delivery, DeliveryStatus, Subscription } from "./domain/types.ts";
import type { ProbeResult, SubscriptionCandidate } from "./probe/index.ts";
import { ProbeError } from "./probe/index.ts";
import type { SourcePollResult } from "./scheduler.ts";
import { redactSensitiveUrls } from "./security/redaction.ts";

interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface CliDependencies {
  probeUrl(url: string): Promise<ProbeResult>;
  follow(candidate: SubscriptionCandidate, intervalMinutes: number): Subscription;
  list(): Subscription[];
  resolveSubscription(target: string): Subscription;
  setEnabled(id: string, enabled: boolean): Subscription;
  remove(id: string): void;
  poll(id: string): Promise<SourcePollResult>;
  listDeliveries(status?: DeliveryStatus): Delivery[];
  retryDelivery(id: string): Delivery;
  io: CliIo;
}

export function createCliDependencies(services: ApplicationServices, io: CliIo): CliDependencies {
  return {
    probeUrl: (url) => services.probe.probe(url),
    follow: (candidate, intervalMinutes) =>
      services.subscriptions.follow({ candidate, intervalMinutes }).subscription,
    list: () => services.subscriptions.list(),
    resolveSubscription: (target) => services.subscriptions.resolve(target),
    setEnabled: (id, enabled) =>
      enabled ? services.subscriptions.resume(id) : services.subscriptions.pause(id),
    remove: (id) => {
      services.subscriptions.remove(id);
    },
    poll: (id) => services.subscriptions.poll(id),
    listDeliveries: (status) => services.deliveries.list(status),
    retryDelivery: (id) => services.deliveries.retry(id),
    io,
  };
}

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "CliError";
  }
}

function safeTerminalText(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
    })
    .join("");
}

function usage(): string {
  return `Usage:
  curio probe <url> [--json]
  curio follow <url> [--candidate <n>] [--interval-minutes <5-10080>] [--json]
  curio list [--json]
  curio show <subscription-id|source-url> [--json]
  curio pause <subscription-id|source-url> [--json]
  curio resume <subscription-id|source-url> [--json]
  curio remove <subscription-id|source-url> [--json]
  curio poll <subscription-id|source-url> [--json]
  curio deliveries list [--status <status>] [--json]
  curio deliveries retry <delivery-id> [--json]
`;
}

export function formatHumanResult(result: ProbeResult): string {
  const lines = [`Probe: ${result.finalUrl}`];
  if (result.candidates.length === 0) lines.push("No subscription candidates found.");

  for (const candidate of result.candidates) {
    lines.push(
      safeTerminalText(`- [${candidate.format}] ${candidate.title ?? candidate.sourceUrl}`),
    );
    if (candidate.title) lines.push(safeTerminalText(`  ${candidate.sourceUrl}`));
  }
  for (const warning of result.warnings) {
    lines.push(
      safeTerminalText(`Warning: ${warning.url ? `${warning.url}: ` : ""}${warning.message}`),
    );
  }
  return lines.join("\n");
}

interface ParsedArgs {
  command: string;
  positional: string[];
  json: boolean;
  candidate?: number;
  intervalMinutes: number;
  status?: DeliveryStatus;
}

function parseInteger(value: string | undefined, flag: string): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new CliError("usage_error", `${flag} requires an integer`);
  }
  return Number(value);
}

function parseArgs(args: string[]): ParsedArgs {
  const command = args[0] ?? "";
  const positional: string[] = [];
  let json = false;
  let candidate: number | undefined;
  let intervalMinutes = 60;
  let status: DeliveryStatus | undefined;

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--json") {
      json = true;
    } else if (argument === "--candidate") {
      candidate = parseInteger(args[++index], "--candidate");
    } else if (argument === "--interval-minutes") {
      intervalMinutes = parseInteger(args[++index], "--interval-minutes");
    } else if (argument === "--status") {
      const value = args[++index];
      if (!DELIVERY_STATUSES.includes(value as DeliveryStatus)) {
        throw new CliError("usage_error", `Invalid delivery status: ${value ?? "missing"}`);
      }
      status = value as DeliveryStatus;
    } else if (argument.startsWith("--")) {
      throw new CliError("usage_error", `Unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }

  if (intervalMinutes < 5 || intervalMinutes > 10_080) {
    throw new CliError("usage_error", "--interval-minutes must be between 5 and 10080");
  }
  return { command, positional, json, candidate, intervalMinutes, status };
}

function selectCandidate(
  result: ProbeResult,
  selection: number | undefined,
): SubscriptionCandidate {
  if (result.candidates.length === 0) {
    throw new CliError("no_candidates", "No subscription candidates found", result);
  }
  if (selection === undefined) {
    if (result.candidates.length !== 1) {
      throw new CliError(
        "candidate_required",
        "Multiple subscription candidates found; use --candidate <n>",
        result,
      );
    }
    return result.candidates[0] as SubscriptionCandidate;
  }
  if (selection < 1 || selection > result.candidates.length) {
    throw new CliError(
      "invalid_candidate",
      `Candidate must be between 1 and ${result.candidates.length}`,
      result,
    );
  }
  return result.candidates[selection - 1] as SubscriptionCandidate;
}

function humanSubscription(subscription: Subscription): string {
  return safeTerminalText(
    `${subscription.enabled ? "active" : "paused"} ${subscription.id} ${subscription.sourceUrl}`,
  );
}

function writeSuccess(
  dependencies: CliDependencies,
  parsed: ParsedArgs,
  data: unknown,
  human: string,
): void {
  dependencies.io.stdout(
    parsed.json ? JSON.stringify({ ok: true, command: parsed.command, data }) : human,
  );
}

export async function runCli(args: string[], dependencies: CliDependencies): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
    const targetCommands = new Set(["show", "pause", "resume", "remove", "poll"]);
    if (parsed.command === "probe" || parsed.command === "follow") {
      if (parsed.positional.length !== 1) throw new CliError("usage_error", usage());
    } else if (parsed.command === "list") {
      if (parsed.positional.length !== 0) throw new CliError("usage_error", usage());
    } else if (parsed.command === "deliveries") {
      const action = parsed.positional[0];
      if (
        (action === "list" && parsed.positional.length !== 1) ||
        (action === "retry" && parsed.positional.length !== 2) ||
        (action !== "list" && action !== "retry")
      ) {
        throw new CliError("usage_error", usage());
      }
    } else if (targetCommands.has(parsed.command)) {
      if (parsed.positional.length !== 1) throw new CliError("usage_error", usage());
    } else {
      throw new CliError("usage_error", usage());
    }

    if (parsed.command === "probe") {
      const result = await dependencies.probeUrl(parsed.positional[0] as string);
      dependencies.io.stdout(parsed.json ? JSON.stringify(result) : formatHumanResult(result));
      return 0;
    }
    if (parsed.command === "follow") {
      const result = await dependencies.probeUrl(parsed.positional[0] as string);
      const selected = selectCandidate(result, parsed.candidate);
      const subscription = dependencies.follow(selected, parsed.intervalMinutes);
      writeSuccess(dependencies, parsed, subscription, humanSubscription(subscription));
      return 0;
    }
    if (parsed.command === "list") {
      const subscriptions = dependencies.list();
      writeSuccess(
        dependencies,
        parsed,
        subscriptions,
        subscriptions.map(humanSubscription).join("\n") || "No subscriptions.",
      );
      return 0;
    }
    if (parsed.command === "deliveries") {
      if (parsed.positional[0] === "list") {
        const deliveries = dependencies.listDeliveries(parsed.status);
        writeSuccess(
          dependencies,
          parsed,
          deliveries,
          deliveries.map((delivery) => `${delivery.status} ${delivery.id}`).join("\n") ||
            "No deliveries.",
        );
      } else {
        const delivery = dependencies.retryDelivery(parsed.positional[1] as string);
        writeSuccess(dependencies, parsed, delivery, `pending ${delivery.id}`);
      }
      return 0;
    }

    const subscription = dependencies.resolveSubscription(parsed.positional[0] as string);
    if (parsed.command === "show") {
      writeSuccess(dependencies, parsed, subscription, humanSubscription(subscription));
    } else if (parsed.command === "pause" || parsed.command === "resume") {
      const updated = dependencies.setEnabled(subscription.id, parsed.command === "resume");
      writeSuccess(dependencies, parsed, updated, humanSubscription(updated));
    } else if (parsed.command === "remove") {
      dependencies.remove(subscription.id);
      writeSuccess(dependencies, parsed, { id: subscription.id }, `removed ${subscription.id}`);
    } else {
      const result = await dependencies.poll(subscription.id);
      writeSuccess(dependencies, parsed, result, `${result.status} ${subscription.id}`);
    }
    return 0;
  } catch (error) {
    const cliError =
      error instanceof CliError
        ? error
        : error instanceof AppError
          ? new CliError(error.code, error.message, error.details)
          : error instanceof ProbeError
            ? new CliError(error.code, error.message)
            : new CliError(
                "unexpected_error",
                error instanceof Error ? error.message : String(error),
              );
    if (args.includes("--json") && cliError.details !== undefined) {
      dependencies.io.stdout(
        JSON.stringify({
          ok: false,
          error: { code: cliError.code, message: cliError.message, details: cliError.details },
        }),
      );
    }
    dependencies.io.stderr(
      `${cliError.code}: ${safeTerminalText(redactSensitiveUrls(cliError.message))}`,
    );
    return cliError.code === "usage_error" ? 2 : 1;
  }
}

if (import.meta.main) {
  const xAuthToken = process.env.X_AUTH_TOKEN?.trim() ?? "";
  const xCt0 = process.env.X_CT0?.trim() ?? "";
  const githubToken = process.env.GITHUB_TOKEN?.trim() ?? "";
  const app = createApp({
    databasePath: process.env.DATABASE_PATH ?? "./data/curio.db",
    migrationsPath: process.env.MIGRATIONS_PATH,
    x: xAuthToken && xCt0 ? { authToken: xAuthToken, ct0: xCt0 } : null,
    github: githubToken ? { token: githubToken } : null,
  });
  try {
    process.exitCode = await runCli(
      process.argv.slice(2),
      createCliDependencies(app.services, { stdout: console.log, stderr: console.error }),
    );
  } finally {
    app.close();
  }
}
