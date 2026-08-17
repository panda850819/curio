import type { Config } from "../config.ts";
import {
  type DestinationRepository,
  DuplicateDestinationError,
} from "../db/routing-repositories.ts";
import {
  type TelegramChatMetadata,
  TelegramDestinationAdapter,
  type TelegramTransport,
} from "../delivery/telegram.ts";
import type {
  Destination,
  DestinationUpdate,
  JsonValue,
  NewDestination,
  PageCursor,
} from "../domain/types.ts";
import { AppError } from "./errors.ts";
import { type Page, pageResult } from "./pagination.ts";
import type {
  DestinationService as DestinationServiceContract,
  DestinationVerification,
} from "./types.ts";

function validateTelegramConfig(config: JsonValue): void {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new AppError(
      "validation",
      "invalid_destination_config",
      "Telegram config must be an object",
    );
  }
  const unknownKey = Object.keys(config).find((key) => key !== "chatId");
  if (unknownKey) {
    throw new AppError(
      "validation",
      "invalid_destination_config",
      "Telegram config contains unsupported fields",
    );
  }
  if (typeof config.chatId !== "string" || !config.chatId.trim()) {
    throw new AppError(
      "validation",
      "invalid_destination_config",
      "Telegram config requires a chatId",
    );
  }
}

function chatIdOf(destination: Destination): string {
  validateTelegramConfig(destination.config);
  if (destination.config === null || typeof destination.config !== "object") {
    throw new AppError(
      "unexpected",
      "invalid_destination_config",
      "Destination chat ID is invalid",
    );
  }
  const config = destination.config as { [key: string]: JsonValue };
  return config.chatId as string;
}

function publicDestination(destination: Destination): Destination {
  const config = destination.config;
  const chatId =
    config !== null && typeof config === "object" && !Array.isArray(config)
      ? config.chatId
      : undefined;
  return {
    ...destination,
    config: typeof chatId === "string" ? { chatId } : {},
  };
}

export class DefaultDestinationService implements DestinationServiceContract {
  constructor(
    private readonly destinations: DestinationRepository,
    private readonly telegram: Config["telegram"] = null,
    private readonly telegramTransport?: TelegramTransport,
  ) {}

  listPage(limit = 100, cursor?: PageCursor): Page<Destination> {
    const result = this.destinations.listPage(limit, cursor);
    return pageResult(result.items.map(publicDestination), result.hasMore, (item) => ({
      timestamp: item.createdAt,
      id: item.id,
    }));
  }

  get(id: string): Destination {
    const destination = this.destinations.findById(id);
    if (!destination) {
      throw new AppError("not_found", "destination_not_found", "Destination not found");
    }
    return publicDestination(destination);
  }

  create(input: NewDestination): Destination {
    validateTelegramConfig(input.config);
    try {
      return publicDestination(this.destinations.create(input));
    } catch (error) {
      if (error instanceof DuplicateDestinationError) {
        throw new AppError("conflict", "destination_exists", error.message, undefined, {
          cause: error,
        });
      }
      throw error;
    }
  }

  update(id: string, input: DestinationUpdate): Destination {
    this.get(id);
    if (input.config !== undefined) validateTelegramConfig(input.config);
    const destination = this.destinations.update(id, input);
    if (!destination) {
      throw new AppError("not_found", "destination_not_found", "Destination not found");
    }
    return publicDestination(destination);
  }

  async verify(id: string): Promise<DestinationVerification> {
    const destination = this.get(id);
    if (!this.telegram) {
      throw new AppError(
        "conflict",
        "telegram_not_configured",
        "Telegram bot credentials are not configured",
      );
    }
    const adapter = new TelegramDestinationAdapter(this.telegram.botToken, this.telegramTransport);
    const chat: TelegramChatMetadata = await adapter.verifyChat(chatIdOf(destination));
    return { destinationId: destination.id, chat };
  }
}
