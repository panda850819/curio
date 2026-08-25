import { AppError, toAppError } from "../app/errors.ts";
import type { ItemRepository } from "../db/repositories.ts";
import type { Item, ItemEnrichment, ItemReaderState, SavedQuote } from "../domain/types.ts";
import type { ProbeHttpClient } from "../probe/types.ts";
import {
  HtmlContentEmptyError,
  HtmlContentTooLargeError,
  HtmlSelectorError,
  normalizeHtmlDocument,
} from "../sources/html/normalize.ts";
import { parseReaderHtml, readerBlocksText, renderReaderBlocks } from "./content.ts";
import { presentReaderContent, type ReaderContentPresentation } from "./presentation.ts";
import type { ItemEnrichmentRepository } from "./repository.ts";
import type { ReaderStateRepository } from "./state-repository.ts";

const MAXIMUM_ARTICLE_BYTES = 1024 * 1024;
const MINIMUM_ARTICLE_CHARACTERS = 40;
const ARTICLE_SELECTORS = [
  "main article",
  "article",
  "main",
  "[role=main]",
  ".entry-content",
  ".post-content",
];

export interface ReaderQuote extends SavedQuote {
  detached: boolean;
}

export interface ReaderItem {
  item: Item;
  enrichment: ItemEnrichment | null;
  contentHtml: string | null;
  contentText: string | null;
  readableText: string;
  presentation: ReaderContentPresentation;
  state: ItemReaderState;
  quotes: ReaderQuote[];
}

export interface SaveQuoteResult {
  quote: ReaderQuote;
  disposition: "created" | "existing";
}

export interface EnrichItemResult {
  item: Item;
  enrichment: ItemEnrichment;
  disposition: "cached" | "enriched" | "refreshed";
}

function provenanceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "invalid-source-url";
  }
}

function itemById(items: ItemRepository, id: string): Item {
  const item = items.findById(id.trim());
  if (!item) throw new AppError("not_found", "item_not_found", "找不到這篇內容");
  return item;
}

function requireArticleContentType(value: string | null): void {
  const contentType = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
    throw new AppError(
      "validation",
      "enrichment_content_type_unsupported",
      "來源不是可擷取的 HTML 文章",
    );
  }
}

function articleResponseLimit(): number {
  return MAXIMUM_ARTICLE_BYTES;
}

function stripPageChrome(html: string): string {
  return new HTMLRewriter()
    .on("nav, aside, header, footer, form, dialog", {
      element(element) {
        element.remove();
      },
    })
    .transform(html);
}

function safeArticle(html: string, baseUrl: string): { contentHtml: string; contentText: string } {
  const candidates: Array<{ html: string; selector?: string }> = ARTICLE_SELECTORS.map(
    (selector) => ({ html, selector }),
  );
  candidates.push({ html: stripPageChrome(html) });

  for (const candidate of candidates) {
    try {
      const normalized = normalizeHtmlDocument(
        candidate.html,
        baseUrl,
        candidate.selector,
        MAXIMUM_ARTICLE_BYTES,
      );
      const blocks = parseReaderHtml(normalized.readableHtml, baseUrl);
      const contentText = readerBlocksText(blocks);
      if (contentText.length < MINIMUM_ARTICLE_CHARACTERS) continue;
      const contentHtml = renderReaderBlocks(blocks);
      if (!contentHtml) continue;
      return { contentHtml, contentText };
    } catch (error) {
      if (error instanceof HtmlSelectorError || error instanceof HtmlContentEmptyError) continue;
      if (error instanceof HtmlContentTooLargeError) {
        throw new AppError(
          "validation",
          "enrichment_content_too_large",
          "擷取後的文章內容超過大小限制",
        );
      }
      throw error;
    }
  }
  throw new AppError("validation", "enrichment_content_empty", "找不到足夠的靜態文章正文");
}

function readerPresentation(input: {
  item: Item;
  contentHtml: string | null;
  contentText: string | null;
}): ReaderContentPresentation {
  return presentReaderContent(input);
}

function defaultReaderState(item: Item): ItemReaderState {
  return {
    itemId: item.id,
    isRead: false,
    isFavorite: false,
    readAt: null,
    createdAt: item.createdAt,
    updatedAt: item.createdAt,
  };
}

function quoteAttached(quote: SavedQuote, currentText: string): boolean {
  let index = currentText.indexOf(quote.exactText);
  if (index < 0) return false;
  while (index >= 0) {
    const prefix = currentText.slice(Math.max(0, index - quote.prefixContext.length), index);
    const suffix = currentText.slice(
      index + quote.exactText.length,
      index + quote.exactText.length + quote.suffixContext.length,
    );
    if (
      (!quote.prefixContext || prefix === quote.prefixContext) &&
      (!quote.suffixContext || suffix === quote.suffixContext)
    ) {
      return true;
    }
    index = currentText.indexOf(quote.exactText, index + 1);
  }
  return currentText.split(quote.exactText).length === 2;
}

export class DefaultReaderService {
  private readonly inFlight = new Map<string, Promise<EnrichItemResult>>();

  constructor(
    private readonly items: ItemRepository,
    private readonly enrichments: ItemEnrichmentRepository,
    private readonly client: ProbeHttpClient,
    private readonly readerState: ReaderStateRepository,
  ) {}

  get(itemId: string): ReaderItem {
    const item = itemById(this.items, itemId);
    const enrichment = this.enrichments.findByItemId(item.id);
    const contentHtml = enrichment?.contentHtml ?? item.contentHtml ?? null;
    const contentText = enrichment?.contentText ?? item.contentText ?? null;
    const presentation = readerPresentation({ item, contentHtml, contentText });
    const quotes = this.readerState.listQuotes(item.id).map((quote) => ({
      ...quote,
      detached: !quoteAttached(quote, presentation.readableText),
    }));
    return {
      item,
      enrichment,
      contentHtml,
      contentText,
      readableText: presentation.readableText,
      presentation,
      state: this.readerState.findState(item.id) ?? defaultReaderState(item),
      quotes,
    };
  }

  getPreview(itemId: string): string {
    const item = itemById(this.items, itemId);
    if (item.summary?.trim()) {
      const source = item.summary.slice(0, 20_000);
      const preview = /<\/?[a-z][\s\S]*>/iu.test(source)
        ? readerBlocksText(parseReaderHtml(source, item.url))
        : source.trim();
      if (preview) return preview.slice(0, 2_000);
    }
    if (item.contentText?.trim()) return item.contentText.trim().slice(0, 2_000);
    return this.getReadableText(item.id).slice(0, 2_000);
  }

  getReadableText(itemId: string): string {
    const item = itemById(this.items, itemId);
    const enrichment = this.enrichments.findByItemId(item.id);
    return readerPresentation({
      item,
      contentHtml: enrichment?.contentHtml ?? item.contentHtml ?? null,
      contentText: enrichment?.contentText ?? item.contentText ?? null,
    }).readableText;
  }

  getState(itemId: string): ItemReaderState {
    const item = itemById(this.items, itemId);
    return this.readerState.findState(item.id) ?? defaultReaderState(item);
  }

  markRead(itemId: string, isRead: boolean): ItemReaderState {
    const item = itemById(this.items, itemId);
    return this.readerState.updateState(item.id, { isRead });
  }

  setFavorite(itemId: string, isFavorite: boolean): ItemReaderState {
    const item = itemById(this.items, itemId);
    return this.readerState.updateState(item.id, { isFavorite });
  }

  saveQuote(itemId: string, input: { text: string; note?: string | null }): SaveQuoteResult {
    const readerItem = this.get(itemId);
    const exactText = input.text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
    if (!exactText || exactText.length > 5_000 || exactText.includes("\u0000")) {
      throw new AppError("validation", "quote_text_invalid", "摘錄文字必須介於 1 到 5000 個字元");
    }
    const note = input.note?.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim() || null;
    if (note && (note.length > 2_000 || note.includes("\u0000"))) {
      throw new AppError("validation", "quote_note_invalid", "摘錄筆記不能超過 2000 個字元");
    }
    const index = readerItem.readableText.indexOf(exactText);
    if (index < 0) {
      throw new AppError("validation", "quote_text_not_found", "摘錄文字不存在於目前的文章正文");
    }
    const prefixContext = readerItem.readableText.slice(Math.max(0, index - 80), index);
    const suffixContext = readerItem.readableText.slice(
      index + exactText.length,
      index + exactText.length + 80,
    );
    const existing = this.readerState.findDuplicateQuote({
      itemId: readerItem.item.id,
      exactText,
      prefixContext,
      suffixContext,
    });
    if (existing) {
      return { quote: { ...existing, detached: false }, disposition: "existing" };
    }
    const quote = this.readerState.createQuote({
      itemId: readerItem.item.id,
      exactText,
      prefixContext,
      suffixContext,
      note,
    });
    return { quote: { ...quote, detached: false }, disposition: "created" };
  }

  listQuotes(itemId?: string): ReaderQuote[] {
    if (itemId) itemById(this.items, itemId);
    return this.readerState.listQuotes(itemId).map((quote) => {
      const item = itemById(this.items, quote.itemId);
      const enrichment = this.enrichments.findByItemId(item.id);
      const currentText = readerPresentation({
        item,
        contentHtml: enrichment?.contentHtml ?? item.contentHtml ?? null,
        contentText: enrichment?.contentText ?? item.contentText ?? null,
      }).readableText;
      return { ...quote, detached: !quoteAttached(quote, currentText) };
    });
  }

  removeQuote(id: string): { id: string } {
    const quote = this.readerState.findQuote(id.trim());
    if (!quote) throw new AppError("not_found", "quote_not_found", "找不到這則摘錄");
    if (!this.readerState.deleteQuote(quote.id)) {
      throw new AppError("not_found", "quote_not_found", "找不到這則摘錄");
    }
    return { id: quote.id };
  }

  async enrich(itemId: string, options: { force?: boolean } = {}): Promise<EnrichItemResult> {
    const item = itemById(this.items, itemId);
    if (item.contentHtml?.trim() || item.contentText?.trim()) {
      throw new AppError(
        "conflict",
        "item_content_already_available",
        "這篇內容已經有可閱讀的正文",
      );
    }
    if (!item.url?.trim()) {
      throw new AppError("validation", "item_url_missing", "這篇內容沒有可擷取的原文網址");
    }

    const existing = this.enrichments.findByItemId(item.id);
    if (existing?.contentHtml && !options.force) {
      return { item, enrichment: existing, disposition: "cached" };
    }
    const current = this.inFlight.get(item.id);
    if (current) return await current;

    const request = this.fetchAndStore(item, existing?.contentHtml != null).finally(() => {
      this.inFlight.delete(item.id);
    });
    this.inFlight.set(item.id, request);
    return await request;
  }

  private async fetchAndStore(item: Item, refreshing: boolean): Promise<EnrichItemResult> {
    const requestUrl = item.url as string;
    const sourceUrl = provenanceUrl(requestUrl);
    try {
      const response = await this.client.get(requestUrl, articleResponseLimit);
      if (response.status < 200 || response.status >= 300) {
        throw new AppError(
          "conflict",
          "enrichment_http_status",
          `來源暫時無法擷取（HTTP ${response.status}）`,
        );
      }
      requireArticleContentType(response.headers.get("content-type"));
      let html: string;
      try {
        html = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
      } catch {
        throw new AppError(
          "validation",
          "enrichment_encoding_unsupported",
          "來源不是有效的 UTF-8 HTML",
        );
      }
      const article = safeArticle(html, response.url);
      const enrichment = this.enrichments.recordSuccess({
        itemId: item.id,
        sourceUrl,
        fetchedUrl: response.url,
        contentText: article.contentText,
        contentHtml: article.contentHtml,
      });
      return {
        item,
        enrichment,
        disposition: refreshing ? "refreshed" : "enriched",
      };
    } catch (error) {
      this.enrichments.recordFailure({ itemId: item.id, sourceUrl, error });
      throw toAppError(error);
    }
  }
}
