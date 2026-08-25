import { AppError, toAppError } from "../app/errors.ts";
import type { ItemRepository } from "../db/repositories.ts";
import type { Item, ItemEnrichment } from "../domain/types.ts";
import type { ProbeHttpClient } from "../probe/types.ts";
import {
  HtmlContentEmptyError,
  HtmlContentTooLargeError,
  HtmlSelectorError,
  normalizeHtmlDocument,
} from "../sources/html/normalize.ts";
import { parseReaderHtml, readerBlocksText, renderReaderBlocks } from "./content.ts";
import type { ItemEnrichmentRepository } from "./repository.ts";

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

export interface ReaderItem {
  item: Item;
  enrichment: ItemEnrichment | null;
  contentHtml: string | null;
  contentText: string | null;
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
      const blocks = parseReaderHtml(normalized.canonical, baseUrl);
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

export class DefaultReaderService {
  private readonly inFlight = new Map<string, Promise<EnrichItemResult>>();

  constructor(
    private readonly items: ItemRepository,
    private readonly enrichments: ItemEnrichmentRepository,
    private readonly client: ProbeHttpClient,
  ) {}

  get(itemId: string): ReaderItem {
    const item = itemById(this.items, itemId);
    const enrichment = this.enrichments.findByItemId(item.id);
    return {
      item,
      enrichment,
      contentHtml: enrichment?.contentHtml ?? item.contentHtml ?? null,
      contentText: enrichment?.contentText ?? item.contentText ?? null,
    };
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
