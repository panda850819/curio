import { AppError, toAppError } from "../app/errors.ts";
import { decodeCursor } from "../app/pagination.ts";
import type { ApplicationServices } from "../app/types.ts";
import type { Route } from "../domain/types.ts";
import type { SubscriptionCandidate } from "../probe/types.ts";
import { redactSensitiveUrls, sanitizeErrorMessage } from "../security/redaction.ts";
import type { TelegramChannelPost, TelegramChannelPostHandler } from "../sources/telegram/types.ts";
import type { InlineKeyboardButton, InlineKeyboardMarkup, TelegramBotApi } from "./api.ts";
import type { TelegramBotSettings } from "./config.ts";
import type { TelegramBotRepository } from "./repository.ts";

const CONVERSATION_TTL_MS = 15 * 60_000;
const MAX_BUTTON_TEXT = 60;
const PAGE_SIZE = 20;

type BotAction = { action: string; value?: string };

type BotState = {
  phase: "candidate" | "destination" | "interval" | "confirm" | "subscriptions";
  candidates?: SubscriptionCandidate[];
  candidate?: SubscriptionCandidate;
  destinationId?: string;
  intervalMinutes?: number;
  subscriptionsCursor?: string;
  destinationCursor?: string;
  statusCursors?: {
    uncertain?: string;
    permanent?: string;
    uncertainDone?: boolean;
    permanentDone?: boolean;
  };
  actions: Record<string, BotAction>;
};

interface TelegramUser {
  id: string;
}

interface TelegramMessage {
  chatId: string;
  user: TelegramUser | null;
  text: string | null;
}

interface TelegramCallback {
  id: string;
  chatId: string;
  user: TelegramUser;
  data: string;
}

type ParsedUpdate =
  | { updateId: number; kind: "message"; message: TelegramMessage }
  | { updateId: number; kind: "callback"; callback: TelegramCallback }
  | { updateId: number; kind: "channel_post"; post: TelegramChannelPost }
  | { updateId: number; kind: "unsupported" };

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function idValue(value: unknown, allowNegative: boolean): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    if (!allowNegative && value < 0) return null;
    return String(value);
  }
  if (typeof value === "string" && (allowNegative ? /^-?\d+$/u : /^\d+$/u).test(value)) {
    return value;
  }
  return null;
}

function parseUpdate(value: unknown): ParsedUpdate | null {
  const update = objectValue(value);
  const updateId = idValue(update?.update_id, false);
  if (!update || updateId === null) return null;
  const numericUpdateId = Number(updateId);
  const message = objectValue(update.message);
  if (message) {
    const chat = objectValue(message.chat);
    const chatId = idValue(chat?.id, true);
    const from = objectValue(message.from);
    if (!chatId) return { updateId: numericUpdateId, kind: "unsupported" };
    return {
      updateId: numericUpdateId,
      kind: "message",
      message: {
        chatId,
        user: from && idValue(from.id, false) ? { id: idValue(from.id, false) as string } : null,
        text: typeof message.text === "string" ? message.text : null,
      },
    };
  }
  const callback = objectValue(update.callback_query);
  if (callback) {
    const callbackId = typeof callback.id === "string" ? callback.id : null;
    const from = objectValue(callback.from);
    const userId = idValue(from?.id, false);
    const callbackMessage = objectValue(callback.message);
    const chat = objectValue(callbackMessage?.chat);
    const chatId = idValue(chat?.id, true);
    const data = typeof callback.data === "string" ? callback.data : null;
    if (!callbackId || !userId || !chatId || !data) {
      return { updateId: numericUpdateId, kind: "unsupported" };
    }
    return {
      updateId: numericUpdateId,
      kind: "callback",
      callback: { id: callbackId, chatId, user: { id: userId }, data },
    };
  }
  const editedChannelPost = objectValue(update.edited_channel_post);
  const channelPost = objectValue(update.channel_post);
  const rawChannelPost = editedChannelPost ?? channelPost;
  if (rawChannelPost) {
    const chat = objectValue(rawChannelPost.chat);
    const chatId = idValue(chat?.id, true);
    const messageId = idValue(rawChannelPost.message_id, false);
    const date = idValue(rawChannelPost.date, false);
    const editDate =
      rawChannelPost.edit_date === undefined ? null : idValue(rawChannelPost.edit_date, false);
    if (
      !chatId ||
      chat?.type !== "channel" ||
      !messageId ||
      !date ||
      (editDate === null && rawChannelPost.edit_date !== undefined)
    ) {
      return { updateId: numericUpdateId, kind: "unsupported" };
    }
    const text =
      typeof rawChannelPost.text === "string"
        ? rawChannelPost.text
        : typeof rawChannelPost.caption === "string"
          ? rawChannelPost.caption
          : null;
    return {
      updateId: numericUpdateId,
      kind: "channel_post",
      post: {
        updateId: numericUpdateId,
        messageId: Number(messageId),
        chat: {
          id: chatId,
          type: "channel",
          title: typeof chat.title === "string" ? chat.title : null,
          username: typeof chat.username === "string" ? chat.username.replace(/^@/u, "") : null,
        },
        date: Number(date),
        editDate: editDate === null ? null : Number(editDate),
        text,
      },
    };
  }
  return { updateId: numericUpdateId, kind: "unsupported" };
}

function conversationKey(userId: string, chatId: string): string {
  return `${userId}:${chatId}`;
}

function shorten(value: string, maximum = MAX_BUTTON_TEXT): string {
  const characters = [...value.trim()];
  return characters.length <= maximum
    ? characters.join("")
    : `${characters.slice(0, maximum - 1).join("")}…`;
}

function newCallbackToken(): string {
  return `c:${Bun.randomUUIDv7().replaceAll("-", "").slice(0, 24)}`;
}

function jsonState(value: unknown): BotState | null {
  const state = objectValue(value);
  if (!state || typeof state.phase !== "string" || !objectValue(state.actions)) return null;
  if (
    state.phase !== "candidate" &&
    state.phase !== "destination" &&
    state.phase !== "interval" &&
    state.phase !== "confirm" &&
    state.phase !== "subscriptions"
  ) {
    return null;
  }
  return state as unknown as BotState;
}

function displayText(value: string, maximumLength = 512): string {
  return sanitizeErrorMessage(value, maximumLength);
}

function buttonTextForCandidate(candidate: SubscriptionCandidate): string {
  return shorten(displayText(candidate.title?.trim() || redactSensitiveUrls(candidate.sourceUrl)));
}

export class TelegramControlService {
  constructor(
    private readonly services: ApplicationServices,
    private readonly repository: TelegramBotRepository,
    private readonly api: TelegramBotApi,
    private readonly settings: TelegramBotSettings,
    private readonly now: () => number = Date.now,
    private readonly conversationTtlMs = CONVERSATION_TTL_MS,
    private readonly channelPostHandler?: TelegramChannelPostHandler,
  ) {}

  async handleUpdate(value: unknown): Promise<void> {
    const update = parseUpdate(value);
    if (!update) return;
    const timestamp = this.now();
    this.repository.purgeExpired(timestamp);
    const claim = this.repository.beginUpdate(update.updateId, timestamp);
    if (claim === "completed") return;
    if (claim === "in_progress") throw new Error("Telegram update is already being processed");

    try {
      if (update.kind === "unsupported") {
        this.repository.completeUpdate(update.updateId, this.now());
        return;
      }
      if (update.kind === "channel_post") {
        await this.channelPostHandler?.handleChannelPost(update.post);
        this.repository.completeUpdate(update.updateId, this.now());
        return;
      }
      if (
        !this.isAllowed(
          update.kind === "message" ? update.message.user : update.callback.user,
          update.kind === "message" ? update.message.chatId : update.callback.chatId,
        )
      ) {
        if (update.kind === "callback")
          await this.acknowledge(update.callback.id, "Not authorized");
        this.repository.completeUpdate(update.updateId, this.now());
        return;
      }
      if (update.kind === "message") await this.handleMessage(update.message);
      else await this.handleCallback(update.callback);
      this.repository.completeUpdate(update.updateId, this.now());
    } catch (error) {
      if (update.kind === "unsupported" || update.kind === "channel_post") {
        this.repository.releaseUpdate(update.updateId);
        throw error;
      }
      const appError = toAppError(error);
      const message =
        appError.kind === "unexpected"
          ? "Curio 暫時無法完成這個操作，請稍後再試。"
          : appError.message;
      const chatId = update.kind === "message" ? update.message.chatId : update.callback.chatId;
      try {
        await this.send(chatId, sanitizeErrorMessage(message));
        this.repository.completeUpdate(update.updateId, this.now());
      } catch (sendError) {
        this.repository.releaseUpdate(update.updateId);
        throw sendError;
      }
    }
  }

  private isAllowed(user: TelegramUser | null, chatId: string): boolean {
    if (!user || !this.settings.allowedUserIds.includes(user.id)) return false;
    return (
      this.settings.allowedChatIds.length === 0 || this.settings.allowedChatIds.includes(chatId)
    );
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    const text = message.text?.trim();
    if (!text || !message.user) return;
    const key = conversationKey(message.user.id, message.chatId);
    if (text === "/cancel") {
      this.repository.clearConversation(key);
      await this.send(message.chatId, "已取消目前操作。");
      return;
    }
    if (text === "/start") {
      await this.send(
        message.chatId,
        "Curio：貼上 URL 探索訊號源，或使用 /subscriptions、/status。",
      );
      return;
    }
    if (text === "/subscriptions") {
      await this.showSubscriptions(message.chatId, message.user.id, key);
      return;
    }
    if (text === "/status") {
      await this.showStatus(message.chatId, message.user.id, key);
      return;
    }
    if (text.startsWith("/")) {
      await this.send(message.chatId, "可用指令：/start、/subscriptions、/status、/cancel。");
      return;
    }
    if (!/^https?:\/\//iu.test(text)) {
      await this.send(message.chatId, "請貼上 public HTTP(S) URL。");
      return;
    }
    const result = await this.services.probe.probe(text);
    if (result.candidates.length === 0) {
      await this.send(message.chatId, "找不到可建立的訂閱來源。");
      return;
    }
    const actions: Record<string, BotAction> = {};
    const buttons = result.candidates
      .slice(0, 10)
      .map((candidate, index) =>
        this.actionButton(actions, buttonTextForCandidate(candidate), "candidate", String(index)),
      );
    const state: BotState = { phase: "candidate", candidates: result.candidates, actions };
    this.saveState(key, message.user.id, message.chatId, state);
    await this.send(message.chatId, "請選擇訊號源：", this.keyboard(buttons));
  }

  private async showDestinations(
    chatId: string,
    userId: string,
    key: string,
    candidate: SubscriptionCandidate,
    cursor?: string,
  ): Promise<void> {
    const page = this.services.destinations.listPage(
      PAGE_SIZE,
      cursor ? decodeCursor(cursor) : undefined,
    );
    if (page.items.length === 0) {
      await this.send(chatId, "請先在 Curio 建立 Telegram destination。");
      return;
    }
    const actions: Record<string, BotAction> = {};
    const buttons = page.items.map((destination) =>
      this.actionButton(
        actions,
        displayText(destination.destinationKey, 120),
        "destination",
        destination.id,
      ),
    );
    if (page.nextCursor) {
      buttons.push(this.actionButton(actions, "下一頁", "destination_page", page.nextCursor));
    }
    this.saveState(key, userId, chatId, {
      phase: "destination",
      candidate,
      destinationCursor: cursor,
      actions,
    });
    await this.send(chatId, "請選擇 destination：", this.keyboard(buttons));
  }

  private async showSubscriptions(
    chatId: string,
    userId: string,
    key: string,
    cursor?: string,
  ): Promise<void> {
    const page = this.services.subscriptions.listPage(
      PAGE_SIZE,
      cursor ? decodeCursor(cursor) : undefined,
    );
    if (page.items.length === 0) {
      await this.send(chatId, "目前沒有 subscriptions。");
      return;
    }
    const actions: Record<string, BotAction> = {};
    const buttons: InlineKeyboardButton[] = [];
    const lines = page.items.map((subscription) => {
      const status = subscription.enabled ? "啟用" : "暫停";
      const label = displayText(
        subscription.title || redactSensitiveUrls(subscription.sourceUrl),
        120,
      );
      const action = subscription.enabled ? "pause" : "resume";
      buttons.push(this.actionButton(actions, `${status} · ${label}`, action, subscription.id));
      return `• ${status} ${label}`;
    });
    if (page.nextCursor) {
      buttons.push(this.actionButton(actions, "下一頁", "subscriptions_page", page.nextCursor));
    }
    this.saveState(key, userId, chatId, {
      phase: "subscriptions",
      subscriptionsCursor: cursor,
      actions,
    });
    await this.send(chatId, lines.join("\n"), this.keyboard(buttons));
  }

  private async showStatus(
    chatId: string,
    userId: string,
    key: string,
    cursors: BotState["statusCursors"] = {},
  ): Promise<void> {
    const uncertainPage = cursors?.uncertainDone
      ? { items: [], nextCursor: null }
      : this.services.deliveries.listPage(
          "uncertain",
          PAGE_SIZE,
          cursors?.uncertain ? decodeCursor(cursors.uncertain) : undefined,
        );
    const permanentPage = cursors?.permanentDone
      ? { items: [], nextCursor: null }
      : this.services.deliveries.listPage(
          "permanent_failure",
          PAGE_SIZE,
          cursors?.permanent ? decodeCursor(cursors.permanent) : undefined,
        );
    const failedSubscriptions = this.services.subscriptions
      .list(500)
      .filter((subscription) => subscription.consecutiveFailures > 0 || subscription.lastError)
      .slice(0, PAGE_SIZE);
    const actions: Record<string, BotAction> = {};
    const buttons: InlineKeyboardButton[] = [];
    const lines = [
      "失敗 subscriptions：",
      ...(failedSubscriptions.length === 0
        ? ["• 無"]
        : failedSubscriptions.map(
            (subscription) =>
              `• ${displayText(subscription.title || redactSensitiveUrls(subscription.sourceUrl), 120)}：${sanitizeErrorMessage(subscription.lastError || "poll failed")}`,
          )),
      `uncertain deliveries：${uncertainPage.items.length}`,
      `permanent_failure deliveries：${permanentPage.items.length}`,
    ];
    if (uncertainPage.nextCursor || permanentPage.nextCursor) {
      const nextCursors = JSON.stringify({
        ...(uncertainPage.nextCursor ? { uncertain: uncertainPage.nextCursor } : {}),
        ...(permanentPage.nextCursor ? { permanent: permanentPage.nextCursor } : {}),
        ...(uncertainPage.nextCursor ? {} : { uncertainDone: true }),
        ...(permanentPage.nextCursor ? {} : { permanentDone: true }),
      });
      buttons.push(this.actionButton(actions, "下一頁", "status_page", nextCursors));
    }
    if (buttons.length > 0) {
      this.saveState(key, userId, chatId, {
        phase: "subscriptions",
        statusCursors: cursors,
        actions,
      });
    } else {
      this.repository.clearConversation(key);
    }
    await this.send(
      chatId,
      lines.join("\n"),
      buttons.length > 0 ? this.keyboard(buttons) : undefined,
    );
  }

  private async handleCallback(callback: TelegramCallback): Promise<void> {
    await this.acknowledge(callback.id);
    const key = conversationKey(callback.user.id, callback.chatId);
    const conversation = this.repository.getConversation(key, this.now());
    const state = conversation ? jsonState(conversation.state) : null;
    const token = callback.data.startsWith("c:") ? callback.data : "";
    const action = state?.actions[token];
    if (!state || !action) {
      await this.send(callback.chatId, "這個操作已過期，請重新開始。");
      return;
    }
    delete state.actions[token];

    if (action.action === "subscriptions_page") {
      await this.showSubscriptions(callback.chatId, callback.user.id, key, action.value);
      return;
    }

    if (action.action === "status_page") {
      let cursors: BotState["statusCursors"] = {};
      try {
        const parsed: unknown = action.value ? JSON.parse(action.value) : {};
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          cursors = parsed as BotState["statusCursors"];
        }
      } catch {
        await this.send(callback.chatId, "這個操作已失效，請重新執行 /status。");
        return;
      }
      await this.showStatus(callback.chatId, callback.user.id, key, cursors);
      return;
    }

    if (action.action === "candidate") {
      const index = Number(action.value);
      const candidate = state.candidates?.[index];
      if (!candidate) {
        await this.send(callback.chatId, "找不到這個訊號源，請重新貼上 URL。");
        return;
      }
      await this.showDestinations(callback.chatId, callback.user.id, key, candidate);
      return;
    }

    if (action.action === "destination_page") {
      if (!state.candidate) {
        await this.send(callback.chatId, "操作狀態已失效，請重新開始。");
        return;
      }
      await this.showDestinations(
        callback.chatId,
        callback.user.id,
        key,
        state.candidate,
        action.value,
      );
      return;
    }

    if (action.action === "destination") {
      if (!state.candidate || !action.value) {
        await this.send(callback.chatId, "操作狀態已失效，請重新開始。");
        return;
      }
      const destination = this.services.destinations.get(action.value);
      const actions: Record<string, BotAction> = {};
      const buttons = [60, 360].map((minutes) =>
        this.actionButton(actions, `${minutes} 分鐘`, "interval", String(minutes)),
      );
      const nextState: BotState = {
        phase: "interval",
        candidate: state.candidate,
        destinationId: destination.id,
        actions,
      };
      this.saveState(key, callback.user.id, callback.chatId, nextState);
      await this.send(callback.chatId, "請選擇 poll interval：", this.keyboard(buttons));
      return;
    }

    if (action.action === "interval") {
      const intervalMinutes = Number(action.value);
      if (!state.candidate || !state.destinationId || !Number.isSafeInteger(intervalMinutes)) {
        await this.send(callback.chatId, "操作狀態已失效，請重新開始。");
        return;
      }
      const actions: Record<string, BotAction> = {};
      const confirm = this.actionButton(actions, "確認建立訂閱", "confirm");
      this.saveState(key, callback.user.id, callback.chatId, {
        phase: "confirm",
        candidate: state.candidate,
        destinationId: state.destinationId,
        intervalMinutes,
        actions,
      });
      await this.send(
        callback.chatId,
        "確認建立 subscription 與 route？",
        this.keyboard([confirm]),
      );
      return;
    }

    if (action.action === "confirm") {
      if (!state.candidate || !state.destinationId || !state.intervalMinutes) {
        await this.send(callback.chatId, "操作狀態已失效，請重新開始。");
        return;
      }
      const result = await this.services.subscriptions.followVerified({
        candidate: state.candidate,
        intervalMinutes: state.intervalMinutes,
      });
      this.ensureRoute(result.subscription.id, state.destinationId);
      this.repository.clearConversation(key);
      await this.send(
        callback.chatId,
        "已建立 subscription 與 route，下一次 poll 有新內容時會通知。",
        undefined,
      );
      return;
    }

    if ((action.action === "pause" || action.action === "resume") && action.value) {
      const subscription =
        action.action === "pause"
          ? this.services.subscriptions.pause(action.value)
          : this.services.subscriptions.resume(action.value);
      this.repository.clearConversation(key);
      await this.send(
        callback.chatId,
        `${displayText(subscription.title || redactSensitiveUrls(subscription.sourceUrl))} 已${subscription.enabled ? "恢復" : "暫停"}。`,
      );
      return;
    }

    await this.send(callback.chatId, "這個操作已失效，請重新開始。");
  }

  private findRoute(subscriptionId: string, destinationId: string): Route | null {
    let cursor: string | null = null;
    while (true) {
      const page = this.services.routes.listPage(
        PAGE_SIZE,
        subscriptionId,
        cursor ? decodeCursor(cursor) : undefined,
      );
      const route = page.items.find((item) => item.destinationId === destinationId);
      if (route) return route;
      if (!page.nextCursor) return null;
      cursor = page.nextCursor;
    }
  }

  private ensureRoute(subscriptionId: string, destinationId: string): void {
    const existing = this.findRoute(subscriptionId, destinationId);
    if (existing) {
      if (!existing.enabled) this.services.routes.update(existing.id, { enabled: true });
      return;
    }
    try {
      this.services.routes.create({ subscriptionId, destinationId, enabled: true });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "route_exists") throw error;
      const concurrent = this.findRoute(subscriptionId, destinationId);
      if (!concurrent) throw error;
      if (!concurrent.enabled) this.services.routes.update(concurrent.id, { enabled: true });
    }
  }

  private saveState(key: string, userId: string, chatId: string, state: BotState): void {
    this.repository.setConversation(
      key,
      userId,
      chatId,
      state as unknown as import("../domain/types.ts").JsonValue,
      this.now() + this.conversationTtlMs,
      this.now(),
    );
  }

  private actionButton(
    actions: Record<string, BotAction>,
    text: string,
    action: string,
    value?: string,
  ): InlineKeyboardButton {
    const callbackData = newCallbackToken();
    actions[callbackData] = { action, ...(value === undefined ? {} : { value }) };
    return { text: shorten(text), callback_data: callbackData };
  }

  private keyboard(buttons: InlineKeyboardButton[]): InlineKeyboardMarkup {
    return { inline_keyboard: buttons.map((button) => [button]) };
  }

  private async acknowledge(callbackId: string, text?: string): Promise<void> {
    try {
      await this.api.answerCallbackQuery(callbackId, text);
    } catch {
      // A failed acknowledgement must not repeat a state transition.
    }
  }

  private async send(
    chatId: string,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<void> {
    const characters = [...text];
    if (characters.length <= 4_096) {
      await this.api.sendMessage(chatId, text, replyMarkup);
      return;
    }
    for (let index = 0; index < characters.length; index += 4_096) {
      await this.api.sendMessage(
        chatId,
        characters.slice(index, index + 4_096).join(""),
        index === 0 ? replyMarkup : undefined,
      );
    }
  }
}
