import type { CurioApplication } from "../app/create-app.ts";
import { AppError, toAppError } from "../app/errors.ts";
import { decodeCursor } from "../app/pagination.ts";
import { DELIVERY_STATUSES } from "../delivery/types.ts";
import type { DeliveryStatus, Item, NewRoute, Route, Subscription } from "../domain/types.ts";
import type { SubscriptionCandidate } from "../probe/types.ts";
import { redactSensitiveUrls, sanitizeErrorMessage } from "../security/redaction.ts";

const SESSION_TTL_MS = 8 * 60 * 60_000;
const MAX_FORM_BODY_BYTES = 64 * 1024;
const MAX_LIST_ITEMS = 500;
const DISPLAY_LIMIT = 280;

type Flash = { kind: "success" | "error"; text: string };

interface UiSession {
  csrf: string;
  expiresAt: number;
}

interface UiHandlerOptions {
  now?: () => number;
}

interface CandidateView {
  result: {
    inputUrl: string;
    finalUrl: string;
    candidates: SubscriptionCandidate[];
    warnings: Array<{ message: string; url?: string }>;
  };
  selectedUrl?: string;
}

const NOTICE_MESSAGES: Record<string, Flash> = {
  subscription_created: { kind: "success", text: "訂閱與路由已建立。" },
  subscription_paused: { kind: "success", text: "訂閱已暫停。" },
  subscription_resumed: { kind: "success", text: "訂閱已恢復。" },
  subscription_removed: { kind: "success", text: "訂閱已移除。" },
  poll_complete: { kind: "success", text: "輪詢完成，結果已寫入時間軸。" },
  destination_created: { kind: "success", text: "目的地已建立。" },
  destination_toggled: { kind: "success", text: "目的地狀態已更新。" },
  destination_verified: { kind: "success", text: "Telegram 目的地驗證成功。" },
  route_created: { kind: "success", text: "路由已建立。" },
  route_toggled: { kind: "success", text: "路由狀態已更新。" },
  route_removed: { kind: "success", text: "路由已移除。" },
  delivery_retried: { kind: "success", text: "投遞已排入重試。" },
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function displayText(value: unknown, maximum = DISPLAY_LIMIT): string {
  return escapeHtml(sanitizeErrorMessage(String(value ?? ""), maximum));
}

function displayUrl(value: string): string {
  return escapeHtml(redactSensitiveUrls(value));
}

function safeExternalHref(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search) return null;
    return escapeHtml(url.toString());
  } catch {
    return null;
  }
}

function truncate(value: string | null | undefined, maximum = DISPLAY_LIMIT): string {
  const text = sanitizeErrorMessage(value ?? "", maximum);
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function formatDate(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return "尚未";
  try {
    return new Intl.DateTimeFormat("zh-TW", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(timestamp));
  } catch {
    return "時間未知";
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-TW").format(value);
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

function randomToken(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function safePathSegment(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.includes("/")) throw new Error("invalid segment");
    return decoded;
  } catch {
    throw new AppError("validation", "invalid_path", "路徑參數無效");
  }
}

export function isValidUiPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/privacy" ||
    pathname === "/terms" ||
    pathname === "/subscriptions" ||
    pathname.startsWith("/subscriptions/") ||
    pathname === "/destinations" ||
    pathname.startsWith("/destinations/") ||
    pathname === "/routes" ||
    pathname.startsWith("/routes/") ||
    pathname === "/deliveries" ||
    pathname.startsWith("/deliveries/")
  );
}

function csrfField(session: UiSession): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">`;
}

const UI_LABELS: Record<string, string> = {
  Dashboard: "總覽",
  Privacy: "隱私",
  Terms: "使用條款",
  "Probe candidates": "來源候選",
  Error: "錯誤",
  "Add subscription": "新增訂閱",
  "Subscription detail": "訂閱詳情",
  Subscriptions: "訂閱",
  Destinations: "目的地",
  Deliveries: "投遞",
  Source: "來源",
  "No preview": "沒有預覽內容",
  "Untitled item": "未命名項目",
  Disable: "停用",
  Enable: "啟用",
  Remove: "移除",
  Verify: "驗證",
  "Open source": "開啟來源",
  "Page not found": "找不到這個頁面",
  "Action not found": "找不到這個操作",
  "Destination is disabled": "目的地已停用",
  "Delivery status is invalid": "投遞狀態無效",
  "Candidate is invalid": "來源候選無效",
  "Candidate adapter is invalid": "來源 adapter 無效",
  "Candidate format is invalid": "來源格式無效",
  "Candidate discovery method is invalid": "來源探索方式無效",
  "Candidate URL is invalid": "來源 URL 無效",
  "Poll now": "立即輪詢",
  "Pause source": "暫停來源",
  "Resume source": "恢復來源",
  "Retry delivery": "重試投遞",
  "No error": "沒有錯誤",
  "Remove this route?": "要移除這條路由嗎？",
  "No destinations": "還沒有目的地",
  "Create a Telegram destination before adding a route.": "請先建立 Telegram 目的地，再新增路由。",
  "No routes": "還沒有路由",
  "Open a subscription to route it to an enabled destination.":
    "開啟訂閱後，將它連到啟用中的目的地。",
  "outlets / routing": "出口／路由",
  "Destinations & routes": "目的地與路由",
  "Verify Telegram outlets, turn them on or off, and decide which sources arrive where.":
    "驗證 Telegram 目的地、切換啟用狀態，並決定各來源要送到哪裡。",
  telegram: "Telegram",
  delivered: "已投遞",
  retry: "重試",
  uncertain: "待確認",
  permanent_failure: "永久失敗",
};

function buttonLabel(label: string): string {
  return escapeHtml(UI_LABELS[label] ?? label);
}

const STATUS_LABELS: Record<string, string> = {
  active: "啟用中",
  disabled: "已停用",
  enabled: "已啟用",
  paused: "已暫停",
  pending: "等待投遞",
  processing: "處理中",
  retry_scheduled: "已排程重試",
  delivered: "已投遞",
  uncertain: "待確認",
  permanent_failure: "永久失敗",
  retry: "重試",
};

function statusLabel(value: string): string {
  return STATUS_LABELS[value] ?? value;
}

function discoveryLabel(value: string): string {
  return { direct: "直接來源", "html-link": "HTML 連結" }[value] ?? value;
}

function adapterLabel(value: string): string {
  return (
    {
      rss: "RSS",
      atom: "Atom",
      rdf: "RDF",
      x: "X",
      html: "HTML",
      youtube: "YouTube",
      telegram: "Telegram Bot",
      telegram_html: "Telegram HTML",
    }[value] ?? value
  );
}

function statusPill(status: string, label = status): string {
  const normalized = status.toLowerCase().replaceAll("_", "-");
  return `<span class="status status-${escapeHtml(normalized)}">${buttonLabel(statusLabel(label))}</span>`;
}

function link(href: string, label: string, className = ""): string {
  return `<a class="button-link ${escapeHtml(className)}" href="${escapeHtml(href)}">${buttonLabel(label)}</a>`;
}

function actionForm(
  action: string,
  csrf: UiSession,
  label: string,
  options: { className?: string; confirm?: string; kind?: "button" | "danger" } = {},
): string {
  const confirm = options.confirm
    ? ` onsubmit="return window.confirm('${buttonLabel(options.confirm)}')"`
    : "";
  const kind = options.kind === "danger" ? " button-danger" : "";
  return `<form class="inline-form" method="post" action="${escapeHtml(action)}" data-loading${confirm}>${csrfField(csrf)}<button class="button ${escapeHtml(options.className ?? "")}${kind}" type="submit">${buttonLabel(label)}</button></form>`;
}

function pollAction(
  subscription: Pick<Subscription, "adapter">,
  id: string,
  session: UiSession,
  className: string,
  label: string,
): string {
  return subscription.adapter === "telegram"
    ? ""
    : actionForm(`/subscriptions/${encodeURIComponent(id)}/poll`, session, label, { className });
}

function scheduleLabel(
  subscription: Pick<Subscription, "adapter" | "pollIntervalMinutes">,
): string {
  return subscription.adapter === "telegram"
    ? "事件驅動"
    : `每 ${formatNumber(subscription.pollIntervalMinutes)} 分鐘`;
}

function heading(eyebrow: string, title: string, lede: string, actions = ""): string {
  return `<header class="page-heading"><div><p class="eyebrow">${buttonLabel(eyebrow)}</p><h1>${buttonLabel(title)}</h1><p class="lede">${buttonLabel(lede)}</p></div><div class="page-actions">${actions}</div></header>`;
}

function emptyState(title: string, message: string, action = ""): string {
  return `<div class="empty-state"><span class="empty-mark" aria-hidden="true">○</span><h2>${buttonLabel(title)}</h2><p>${buttonLabel(message)}</p>${action}</div>`;
}

function renderShell(
  title: string,
  active: string,
  content: string,
  _session: UiSession,
  flash?: Flash,
): string {
  const nav = [
    ["/", "總覽", "dashboard"],
    ["/subscriptions", "訂閱", "subscriptions"],
    ["/destinations", "目的地", "destinations"],
    ["/deliveries", "投遞", "deliveries"],
  ] as const;
  const navHtml = nav
    .map(
      ([href, label, key]) =>
        `<a href="${href}"${active === key ? ' aria-current="page" class="active"' : ""}>${buttonLabel(label)}</a>`,
    )
    .join("");
  const flashHtml = flash
    ? `<div class="flash flash-${flash.kind}" role="${flash.kind === "error" ? "alert" : "status"}" aria-live="polite"><span aria-hidden="true">${flash.kind === "error" ? "!" : "✓"}</span>${buttonLabel(flash.text)}</div>`
    : "";
  return `<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="description" content="Curio 單一使用者資訊足跡">
<title>${buttonLabel(title)} · Curio</title>
<style>${STYLES}</style>
</head>
<body>
<a class="skip-link" href="#main-content">跳到主要內容</a>
<div class="app-shell">
  <header class="topbar">
    <a class="brand" href="/" aria-label="Curio 首頁"><span class="brand-mark" aria-hidden="true">✳</span><span><strong>Curio</strong><small>好奇足跡的田野筆記</small></span></a>
    <nav class="primary-nav" aria-label="主要導覽">${navHtml}</nav>
    <span class="environment-label">單一使用者／本機</span>
  </header>
  <main id="main-content" tabindex="-1">
    ${flashHtml}
    ${content}
  </main>
  <footer class="footer"><span>Curio · 收藏好奇，追蹤足跡。</span><span><a href="/privacy">隱私</a><a href="/terms">使用條款</a></span></footer>
</div>
<script>
for (const form of document.querySelectorAll('form[data-loading]')) {
  form.addEventListener('submit', () => {
    const button = form.querySelector('button[type="submit"]');
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); button.dataset.originalLabel = button.textContent || ''; button.textContent = '處理中…'; }
  });
}
</script>
</body>
</html>`;
}

const STYLES = `
:root {
  --ink: oklch(24% 0.035 145);
  --ink-soft: oklch(42% 0.035 145);
  --paper: oklch(96% 0.018 88);
  --paper-deep: oklch(92% 0.025 88);
  --paper-lift: oklch(99% 0.012 88);
  --moss: oklch(45% 0.09 145);
  --moss-dark: oklch(33% 0.065 145);
  --brass: oklch(67% 0.12 76);
  --rust: oklch(52% 0.12 35);
  --line: oklch(76% 0.035 88);
  --radius-sm: 8px;
  --radius-md: 14px;
  --radius-lg: 22px;
  --measure: 74rem;
  color: var(--ink);
  background: var(--paper);
  font-family: -apple-system, "SF Pro Text", "PingFang TC", "Noto Sans TC", sans-serif;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
* { box-sizing: border-box; }
html { background: var(--paper); }
body { margin: 0; min-width: 320px; background: var(--paper); color: var(--ink); line-height: 1.72; }
body, button, input, select, textarea { font: inherit; }
a { color: var(--moss-dark); text-decoration-thickness: 0.08em; text-underline-offset: 0.18em; }
a:hover { color: var(--rust); }
button, .button, .button-link { min-height: 2.65rem; border-radius: var(--radius-sm); }
button, .button { border: 1px solid var(--moss-dark); background: var(--moss-dark); color: var(--paper-lift); padding: 0.55rem 0.9rem; cursor: pointer; font-weight: 700; }
button:hover, .button:hover { background: var(--moss); }
button:active, .button:active, .button-link:active { transform: scale(0.97); }
button:disabled { cursor: wait; opacity: 0.6; }
.button-secondary { background: transparent; color: var(--moss-dark); border-color: var(--moss-dark); }
.button-secondary:hover { color: var(--paper-lift); }
.button-danger { background: transparent; color: var(--rust); border-color: var(--rust); }
.button-danger:hover { background: var(--rust); color: var(--paper-lift); }
.button-link { display: inline-flex; align-items: center; justify-content: center; gap: 0.35rem; border: 1px solid var(--line); padding: 0.5rem 0.85rem; text-decoration: none; font-weight: 700; color: var(--ink); background: var(--paper-lift); }
.button-link:hover { border-color: var(--brass); color: var(--ink); }
.skip-link { position: absolute; left: 1rem; top: -4rem; z-index: 5; background: var(--ink); color: var(--paper); padding: 0.55rem 0.8rem; }
.skip-link:focus { top: 1rem; }
:focus-visible { outline: 3px solid var(--brass); outline-offset: 3px; }
.app-shell { min-height: 100vh; display: grid; grid-template-rows: auto 1fr auto; }
.topbar { width: min(100% - 2rem, var(--measure)); margin: 0 auto; padding: 1.15rem 0 1rem; display: flex; align-items: center; gap: 1.5rem; border-bottom: 1px solid var(--line); }
.brand { display: inline-flex; align-items: center; gap: 0.7rem; color: var(--ink); text-decoration: none; min-width: 14rem; }
.brand-mark { display: grid; place-items: center; width: 2.1rem; height: 2.1rem; border: 1px solid var(--brass); border-radius: 50%; color: var(--rust); font-size: 1.25rem; }
.brand strong { display: block; font-family: "Iowan Old Style", Baskerville, "Songti TC", serif; font-size: 1.3rem; line-height: 1.1; letter-spacing: -0.012em; }
.brand small { display: block; color: var(--ink-soft); font-size: 0.68rem; line-height: 1.2; letter-spacing: 0.04em; }
.primary-nav { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; }
.primary-nav a { padding: 0.45rem 0.65rem; color: var(--ink-soft); text-decoration: none; border-bottom: 2px solid transparent; font-size: 0.92rem; }
.primary-nav a.active { color: var(--ink); border-color: var(--brass); font-weight: 800; }
.environment-label { margin-left: auto; color: var(--ink-soft); font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; white-space: nowrap; }
main { width: min(100% - 2rem, var(--measure)); margin: 0 auto; padding: 3rem 0 5rem; }
.page-heading { display: flex; justify-content: space-between; gap: 2rem; align-items: end; margin-bottom: 2.3rem; }
.page-heading h1 { margin: 0.25rem 0 0.6rem; font-family: "Iowan Old Style", Baskerville, "Songti TC", serif; font-size: clamp(2rem, 4vw, 3.6rem); line-height: 1.08; font-weight: 600; letter-spacing: -0.022em; text-wrap: balance; }
.eyebrow { margin: 0; color: var(--rust); font-size: 0.76rem; font-weight: 800; letter-spacing: 0.13em; text-transform: uppercase; }
.lede { max-width: 62ch; margin: 0; color: var(--ink-soft); text-wrap: pretty; }
.page-actions, .button-row, .inline-form { display: flex; align-items: center; flex-wrap: wrap; gap: 0.55rem; }
.inline-form { display: inline-flex; }
.flash { display: flex; align-items: center; gap: 0.6rem; padding: 0.8rem 1rem; margin-bottom: 1.5rem; border: 1px solid var(--line); background: var(--paper-lift); }
.flash span { display: grid; place-items: center; width: 1.35rem; height: 1.35rem; border-radius: 50%; font-weight: 800; }
.flash-success span { color: var(--paper-lift); background: var(--moss); }
.flash-error { border-color: color-mix(in oklch, var(--rust), var(--line) 55%); }
.flash-error span { color: var(--paper-lift); background: var(--rust); }
.overview-strip { display: grid; grid-template-columns: repeat(4, 1fr); border-top: 2px solid var(--ink); border-bottom: 1px solid var(--line); margin-bottom: 2.4rem; }
.metric { padding: 1rem 1.1rem 1.2rem; border-right: 1px solid var(--line); }
.metric:last-child { border-right: 0; }
.metric dt { color: var(--ink-soft); font-size: 0.78rem; }
.metric dd { margin: 0.15rem 0 0; font-family: "Iowan Old Style", Baskerville, "Songti TC", serif; font-size: 2.25rem; line-height: 1.1; font-variant-numeric: tabular-nums; }
.metric small { color: var(--ink-soft); font-size: 0.75rem; }
.dashboard-grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(18rem, 0.75fr); gap: 2.5rem; align-items: start; }
.stack { display: grid; gap: 1.2rem; }
.section-title { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; border-bottom: 1px solid var(--line); padding-bottom: 0.55rem; }
.section-title h2 { margin: 0; font-family: "Iowan Old Style", Baskerville, "Songti TC", serif; font-size: 1.55rem; font-weight: 600; letter-spacing: -0.012em; }
.section-title a { font-size: 0.82rem; }
.panel { background: var(--paper-lift); border: 1px solid var(--line); border-radius: var(--radius-md); padding: clamp(1rem, 2.3vw, 1.55rem); }
.panel + .panel { margin-top: 1rem; }
.panel-title { margin: 0 0 0.3rem; font-size: 1rem; }
.panel-note { color: var(--ink-soft); font-size: 0.88rem; margin: 0 0 1rem; }
.record-list { display: grid; gap: 0.55rem; }
.record-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1rem; align-items: center; padding: 0.8rem 0; border-bottom: 1px solid var(--line); }
.record-row:last-child { border-bottom: 0; }
.record-row h3, .record-row p { margin: 0; }
.record-row h3 { font-size: 0.98rem; line-height: 1.35; }
.record-row p { color: var(--ink-soft); font-size: 0.82rem; overflow-wrap: anywhere; }
.record-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 0.55rem 0.85rem; color: var(--ink-soft); font-size: 0.8rem; }
.record-actions { display: flex; justify-content: end; align-items: center; flex-wrap: wrap; gap: 0.4rem; }
.record-actions .button, .record-actions .button-link { min-height: 2.25rem; padding: 0.35rem 0.65rem; font-size: 0.8rem; }
.status { display: inline-flex; align-items: center; gap: 0.3rem; width: fit-content; padding: 0.12rem 0.48rem; border: 1px solid var(--line); border-radius: 99px; font-size: 0.72rem; font-weight: 800; line-height: 1.45; }
.status::before { content: ""; width: 0.42rem; height: 0.42rem; border-radius: 50%; background: var(--ink-soft); }
.status-enabled::before, .status-delivered::before, .status-active::before { background: var(--moss); }
.status-disabled::before, .status-paused::before { background: var(--rust); }
.status-uncertain::before, .status-retry-scheduled::before, .status-pending::before { background: var(--brass); }
.status-permanent-failure::before { background: var(--rust); }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.field { display: grid; gap: 0.35rem; }
.field-wide { grid-column: 1 / -1; }
.field label, .fieldset-label { font-size: 0.82rem; font-weight: 800; }
.field-hint { color: var(--ink-soft); font-size: 0.76rem; }
.field-error { color: var(--rust); font-size: 0.8rem; font-weight: 700; }
input, select, textarea { width: 100%; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--paper); color: var(--ink); padding: 0.65rem 0.7rem; }
input:focus, select:focus, textarea:focus { border-color: var(--moss); outline: 3px solid color-mix(in oklch, var(--brass), transparent 50%); }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
fieldset legend { margin-bottom: 0.45rem; font-size: 0.82rem; font-weight: 800; }
.radio-grid { display: grid; gap: 0.55rem; }
.radio-option { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.7rem; align-items: start; border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 0.72rem; background: var(--paper); }
.radio-option:has(input:checked) { border-color: var(--moss); background: color-mix(in oklch, var(--paper), var(--brass) 12%); }
.radio-option input { width: auto; margin-top: 0.3rem; }
.radio-option strong, .radio-option span { display: block; }
.radio-option span { color: var(--ink-soft); font-size: 0.8rem; overflow-wrap: anywhere; }
.notice-list { display: grid; gap: 0.35rem; margin: 1rem 0 0; color: var(--rust); font-size: 0.84rem; }
.panel-error { display: grid; gap: 0.2rem; padding: 1rem; color: var(--rust); border: 1px dashed var(--rust); background: color-mix(in oklch, var(--paper), var(--rust) 5%); }
.panel-error span { color: var(--ink-soft); font-size: 0.86rem; }
.empty-state { padding: 3rem 1rem; text-align: center; border: 1px dashed var(--line); background: var(--paper-lift); }
.empty-mark { display: block; color: var(--brass); font-size: 2.5rem; line-height: 1; }
.empty-state h2 { margin: 0.65rem 0 0.2rem; font-family: "Iowan Old Style", Baskerville, "Songti TC", serif; font-weight: 600; }
.empty-state p { max-width: 42ch; margin: 0 auto 1rem; color: var(--ink-soft); }
.detail-layout { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(18rem, 0.65fr); gap: 2rem; align-items: start; }
.detail-layout > .stack { min-width: 0; }
.key-value { display: grid; grid-template-columns: minmax(8rem, 0.7fr) minmax(0, 1.3fr); gap: 0.55rem 1rem; margin: 0; font-size: 0.86rem; }
.key-value dt { color: var(--ink-soft); }
.key-value dd { margin: 0; overflow-wrap: anywhere; }
.item-preview { padding: 0.8rem 0; border-bottom: 1px solid var(--line); }
.item-preview:last-child { border-bottom: 0; }
.item-preview h3 { margin: 0; font-size: 0.96rem; }
.item-preview p { margin: 0.25rem 0 0; color: var(--ink-soft); font-size: 0.82rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.item-preview time { color: var(--ink-soft); font-size: 0.74rem; }
.toolbar { display: flex; align-items: end; flex-wrap: wrap; gap: 0.7rem; margin-bottom: 1.3rem; padding-bottom: 1rem; border-bottom: 1px solid var(--line); }
.toolbar .field { min-width: 11rem; flex: 1 1 12rem; }
.toolbar .field-small { flex: 0 1 10rem; min-width: 8rem; }
.table-wrap { overflow-x: auto; }
.data-table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
.data-table th, .data-table td { padding: 0.7rem 0.55rem; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
.data-table th { color: var(--ink-soft); font-size: 0.74rem; letter-spacing: 0.05em; text-transform: uppercase; }
.data-table td { overflow-wrap: anywhere; }
.data-table .actions-cell { min-width: 9rem; }
details { border-top: 1px solid var(--line); padding-top: 0.6rem; }
details summary { cursor: pointer; color: var(--moss-dark); font-weight: 800; }
.code-note { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; overflow-wrap: anywhere; }
.footer { width: min(100% - 2rem, var(--measure)); margin: 0 auto; padding: 1.2rem 0 1.8rem; display: flex; justify-content: space-between; gap: 1rem; color: var(--ink-soft); font-size: 0.75rem; border-top: 1px solid var(--line); }
.footer span:last-child { display: flex; gap: 0.8rem; }
@media (hover: hover) { .button-link:hover, button:hover { transition: background-color 140ms ease-out, color 140ms ease-out, border-color 140ms ease-out; } }
@media (max-width: 840px) { .topbar { align-items: start; flex-wrap: wrap; } .primary-nav { order: 3; width: 100%; } .environment-label { margin-left: auto; } .dashboard-grid, .detail-layout { grid-template-columns: 1fr; } }
@media (max-width: 640px) {
  main { padding-top: 2rem; }
  .topbar { width: min(100% - 1.25rem, var(--measure)); }
  main, .footer { width: min(100% - 1.25rem, var(--measure)); }
  .brand { min-width: 0; }
  .environment-label { font-size: 0.66rem; }
  .page-heading { display: grid; gap: 1rem; align-items: start; }
  .page-heading h1 { font-size: 2.35rem; }
  .page-actions { justify-content: start; }
  .overview-strip { grid-template-columns: repeat(2, 1fr); }
  .metric:nth-child(2) { border-right: 0; }
  .metric:nth-child(-n+2) { border-bottom: 1px solid var(--line); }
  .form-grid { grid-template-columns: 1fr; }
  .field-wide { grid-column: auto; }
  .record-row { grid-template-columns: 1fr; gap: 0.7rem; }
  .record-actions { justify-content: start; }
  .key-value { grid-template-columns: 1fr; gap: 0.1rem; }
  .key-value dd { margin-bottom: 0.5rem; }
  .footer { display: grid; }
}
@media (max-width: 430px) {
  .primary-nav { gap: 0; justify-content: space-between; }
  .primary-nav a { padding-inline: 0.35rem; font-size: 0.8rem; }
  .overview-strip { margin-inline: -0.1rem; }
  .metric { padding-inline: 0.65rem; }
  .metric dd { font-size: 1.9rem; }
  .panel { padding: 1rem; }
  .button, .button-link { width: 100%; }
  .inline-form { width: 100%; }
  .inline-form .button { width: 100%; }
  .page-actions > .button-link, .page-actions > .button { width: auto; }
  .toolbar .button { width: auto; }
}
`;

function dashboardContent(app: CurioApplication, _session: UiSession): string {
  const subscriptions = app.services.subscriptions.list(MAX_LIST_ITEMS);
  const deliveryCounts = new Map<DeliveryStatus, number>();
  for (const status of DELIVERY_STATUSES) {
    deliveryCounts.set(status, app.services.deliveries.list(status, MAX_LIST_ITEMS).length);
  }
  const recentItems = app.services.subscriptions.listItemsPage(8).items;
  const failedSubscriptions = subscriptions.filter(
    (subscription) => subscription.consecutiveFailures > 0 || subscription.lastError,
  );
  const active = subscriptions.filter((subscription) => subscription.enabled).length;
  const unresolved =
    (deliveryCounts.get("uncertain") ?? 0) + (deliveryCounts.get("permanent_failure") ?? 0);
  const recent =
    recentItems.length === 0
      ? emptyState(
          "時間軸還是空的",
          "建立第一個 subscription，Curio 會把新內容留下來。",
          link("/subscriptions/new", "新增訂閱"),
        )
      : `<div class="record-list">${recentItems
          .map((item) =>
            itemPreview(
              item,
              subscriptions.find((subscription) => subscription.id === item.subscriptionId)?.title,
            ),
          )
          .join("")}</div>`;
  return `${heading(
    "書桌／今天",
    "你的好奇心索引",
    "在同一張桌面上查看來源健康、投遞狀態與最近拾起的內容。",
    link("/subscriptions/new", "新增訂閱", "button"),
  )}
  <dl class="overview-strip" aria-label="Curio 健康摘要">
    <div class="metric"><dt>啟用中的來源</dt><dd>${formatNumber(active)}</dd><small>共 ${formatNumber(subscriptions.length)} 個追蹤來源</small></div>
    <div class="metric"><dt>有錯誤的訂閱</dt><dd>${formatNumber(failedSubscriptions.length)}</dd><small>輪詢健康度</small></div>
    <div class="metric"><dt>未處理的投遞</dt><dd>${formatNumber(unresolved)}</dd><small>待確認＋永久失敗</small></div>
    <div class="metric"><dt>已投遞</dt><dd>${formatNumber(deliveryCounts.get("delivered") ?? 0)}</dd><small>已記錄的訊息</small></div>
  </dl>
  <div class="dashboard-grid">
    <section class="stack" aria-labelledby="recent-heading"><div class="section-title"><h2 id="recent-heading">最近拾起</h2>${link("/subscriptions", "查看來源")}</div><div class="panel">${recent}</div></section>
    <aside class="stack" aria-label="健康詳情">
      <section class="panel"><div class="section-title"><h2>輪詢健康度</h2>${link("/subscriptions", "管理")}</div>${
        failedSubscriptions.length === 0
          ? `<p class="panel-note">目前沒有失敗的訂閱。</p>${statusPill("active", "一切正常")}`
          : `<div class="record-list">${failedSubscriptions
              .slice(0, 5)
              .map(
                (subscription) =>
                  `<div class="record-row"><div><h3>${link(`/subscriptions/${encodeURIComponent(subscription.id)}`, truncate(subscription.title || subscription.sourceUrl, 90))}</h3><p>${displayText(subscription.lastError || "輪詢失敗", 150)}</p></div>${statusPill("disabled", `${subscription.consecutiveFailures} 次失敗`)}</div>`,
              )
              .join("")}</div>`
      }</section>
      <section class="panel"><div class="section-title"><h2>投遞佇列</h2>${link("/deliveries", "查看")}</div><div class="record-list"><div class="record-row"><div><h3>待確認</h3><p>需要人工判斷是否重試</p></div><strong>${formatNumber(deliveryCounts.get("uncertain") ?? 0)}</strong></div><div class="record-row"><div><h3>永久失敗</h3><p>可以重新排入投遞</p></div><strong>${formatNumber(deliveryCounts.get("permanent_failure") ?? 0)}</strong></div></div></section>
    </aside>
  </div>`;
}

function itemPreview(item: Item, subscriptionTitle?: string | null): string {
  const title = item.title || item.url || "未命名項目";
  const href = item.url ? safeExternalHref(item.url) : null;
  const titleHtml = href
    ? `<a href="${href}" target="_blank" rel="noreferrer">${displayText(title, 150)}</a>`
    : displayText(title, 150);
  return `<article class="item-preview"><h3>${titleHtml}</h3><time datetime="${escapeHtml(new Date(item.publishedAt ?? item.discoveredAt).toISOString())}">${formatDate(item.publishedAt ?? item.discoveredAt)}</time><p>${displayText(subscriptionTitle || "來源", 80)} · ${displayText(item.summary || item.contentText || "沒有預覽內容", 220)}</p></article>`;
}

function subscriptionsContent(app: CurioApplication, session: UiSession, url: URL): string {
  const query = url.searchParams.get("q")?.trim() ?? "";
  const filter = url.searchParams.get("status") ?? "all";
  let subscriptions = app.services.subscriptions.list(MAX_LIST_ITEMS);
  if (query) {
    const needle = query.toLocaleLowerCase("zh-TW");
    subscriptions = subscriptions.filter((subscription) =>
      [subscription.title ?? "", subscription.sourceUrl, subscription.adapter].some((value) =>
        value.toLocaleLowerCase("zh-TW").includes(needle),
      ),
    );
  }
  if (filter === "active")
    subscriptions = subscriptions.filter((subscription) => subscription.enabled);
  if (filter === "paused")
    subscriptions = subscriptions.filter((subscription) => !subscription.enabled);
  const rows = subscriptions
    .map(
      (subscription) =>
        `<article class="record-row"><div><h3><a href="/subscriptions/${encodeURIComponent(subscription.id)}">${displayText(subscription.title || subscription.sourceUrl, 160)}</a></h3><div class="record-meta">${statusPill(subscription.enabled ? "enabled" : "disabled", subscription.enabled ? "active" : "paused")}<span>${adapterLabel(subscription.adapter)}</span><span>${scheduleLabel(subscription)}</span>${subscription.lastError ? `<span>${displayText(subscription.consecutiveFailures)} 次失敗</span>` : ""}</div><p>${displayUrl(subscription.sourceUrl)}</p></div><div class="record-actions">${actionForm(`/subscriptions/${encodeURIComponent(subscription.id)}/${subscription.enabled ? "pause" : "resume"}`, session, subscription.enabled ? "暫停" : "恢復", { className: "button-secondary" })}${pollAction(subscription, subscription.id, session, "button-secondary", "立即輪詢")}${actionForm(`/subscriptions/${encodeURIComponent(subscription.id)}/remove`, session, "移除", { kind: "danger", confirm: "要移除這個訂閱嗎？已收集的內容仍會保留在時間軸。" })}</div></article>`,
    )
    .join("");
  return `${heading(
    "來源／索引",
    "訂閱",
    "搜尋、暫停、手動輪詢，或查看來源的完整健康紀錄。",
    link("/subscriptions/new", "新增訂閱", "button"),
  )}
  <form class="toolbar" method="get" action="/subscriptions"><div class="field"><label for="subscription-search">搜尋來源</label><input id="subscription-search" name="q" value="${escapeHtml(query)}" placeholder="標題、URL、來源類型"></div><div class="field field-small"><label for="subscription-status">篩選</label><select id="subscription-status" name="status"><option value="all"${filter === "all" ? " selected" : ""}>全部</option><option value="active"${filter === "active" ? " selected" : ""}>啟用中</option><option value="paused"${filter === "paused" ? " selected" : ""}>已暫停</option></select></div><button class="button" type="submit">套用</button></form>
  <section class="panel" aria-labelledby="subscription-list-heading"><div class="section-title"><h2 id="subscription-list-heading">${formatNumber(subscriptions.length)} 個來源</h2><span class="panel-note">依建立時間排序</span></div>${subscriptions.length === 0 ? emptyState(query || filter !== "all" ? "沒有符合的來源" : "還沒有訂閱", query || filter !== "all" ? "換一個搜尋字詞或清除篩選。" : "從一個 URL 開始建立追蹤。", link("/subscriptions/new", "新增訂閱")) : `<div class="record-list">${rows}</div>`}</section>`;
}

function newSubscriptionContent(
  app: CurioApplication,
  session: UiSession,
  candidateView?: CandidateView,
  error?: string,
): string {
  const destinations = app.services.destinations
    .listPage(MAX_LIST_ITEMS)
    .items.filter((destination) => destination.enabled);
  const candidates = candidateView?.result.candidates ?? [];
  const selected = candidateView?.selectedUrl ?? candidates[0]?.sourceUrl ?? "";
  const warningHtml = candidateView?.result.warnings.length
    ? `<div class="notice-list" role="status"><strong>探測完成，但有備註</strong>${candidateView.result.warnings.map((warning) => `<span>• ${displayText(warning.message, 180)}</span>`).join("")}</div>`
    : "";
  const candidateOptions = candidates
    .map(
      (candidate) =>
        `<label class="radio-option"><input type="radio" name="candidate" value="${escapeHtml(JSON.stringify(candidate))}"${candidate.sourceUrl === selected ? " checked" : ""} required><span><strong>${displayText(candidate.title || candidate.sourceUrl, 160)}</strong><span>${displayUrl(candidate.sourceUrl)} · ${adapterLabel(candidate.format)}，${discoveryLabel(candidate.discoveredVia)}</span></span></label>`,
    )
    .join("");
  const destinationOptions = destinations
    .map(
      (destination, index) =>
        `<option value="${escapeHtml(destination.id)}"${index === 0 ? " selected" : ""}>${displayText(destination.destinationKey, 100)}</option>`,
    )
    .join("");
  return `${heading("新足跡", "新增訂閱", "探測公開 URL，選擇 Curio 可以追蹤的來源，再將它連到投遞目的地。", link("/subscriptions", "返回訂閱", "button-secondary"))}
  ${error ? `<div class="flash flash-error" role="alert"><span aria-hidden="true">!</span>${buttonLabel(error)}</div>` : ""}
  <section class="panel"><form method="post" action="/subscriptions/probe" data-loading>${csrfField(session)}<div class="field field-wide"><label for="probe-url">公開 URL</label><input id="probe-url" name="url" type="url" inputmode="url" autocomplete="url" placeholder="https://example.com/feed.xml" value="${escapeHtml(candidateView?.result.inputUrl ?? "")}"${error ? ' aria-invalid="true" aria-describedby="probe-url-error"' : ""} required><span class="field-hint">Curio 會阻擋含帳密的 URL 與私人網路目標。</span>${error ? `<span class="field-error" id="probe-url-error">${buttonLabel(error)}</span>` : ""}</div><div class="button-row" style="margin-top:1rem"><button class="button" type="submit">探測 URL</button></div></form></section>
  ${candidates.length === 0 ? `${warningHtml}<section class="panel"><div class="section-title"><h2>下一步</h2></div><p class="panel-note">執行探測後查看可用的來源候選。確認最後的路由前，不會寫入任何資料。</p></section>` : `${warningHtml}<section class="panel"><form method="post" action="/subscriptions/create" data-loading>${csrfField(session)}<fieldset><legend>選擇來源候選</legend><div class="radio-grid">${candidateOptions}</div></fieldset><div class="form-grid" style="margin-top:1.25rem"><div class="field"><label for="destination-id">投遞目的地</label>${destinations.length === 0 ? `<p class="field-hint">沒有啟用中的投遞目的地。${link("/destinations", "請先建立一個")}</p>` : `<select id="destination-id" name="destinationId" required>${destinationOptions}</select>`}</div><div class="field"><label for="poll-interval">輪詢間隔</label><select id="poll-interval" name="intervalMinutes"><option value="60">每 60 分鐘</option><option value="360">每 6 小時</option><option value="1440">每天</option></select></div><div class="field"><label for="backfill-limit">初始回填</label><select id="backfill-limit" name="backfillLimit"><option value="0">不回填較舊內容</option><option value="20" selected>最近 20 筆</option><option value="50">最近 50 筆</option></select><span class="field-hint">只會驗證並寫入選取的來源。</span></div><div class="field field-wide"><label for="html-selector">HTML selector <span class="field-hint">選填</span></label><input id="html-selector" name="selector" placeholder="main article, .content"><span class="field-hint">HTML 監測會使用；feed 訂閱會忽略。</span></div><label class="radio-option field-wide"><input type="checkbox" name="notifyOnFirstPoll" value="true"><span><strong>第一次 HTML 輪詢時通知</strong><span>預設關閉：第一次輪詢只建立靜默基準。</span></span></label></div>${destinations.length === 0 ? "" : `<div class="button-row" style="margin-top:1.25rem"><button class="button" type="submit">建立訂閱與路由</button></div>`}</form></section>`}`;
}

function subscriptionDetailContent(
  app: CurioApplication,
  session: UiSession,
  id: string,
  url: URL,
): string {
  const subscription = app.services.subscriptions.get(id);
  const itemPage = app.services.subscriptions.listItemsPage(
    12,
    id,
    decodeCursor(url.searchParams.get("itemsCursor")),
  );
  const routes = app.services.routes.listPage(MAX_LIST_ITEMS, id).items;
  const destinations = app.services.destinations.listPage(MAX_LIST_ITEMS).items;
  const destinationMap = new Map(destinations.map((destination) => [destination.id, destination]));
  const routeRows = routes
    .map((route) => {
      const destination = destinationMap.get(route.destinationId);
      return `<article class="record-row"><div><h3>${displayText(destination?.destinationKey || route.destinationId, 120)}</h3><div class="record-meta">${statusPill(route.enabled ? "enabled" : "disabled", route.enabled ? "enabled" : "paused")}<span>更新於 ${formatDate(route.updatedAt)}</span></div></div><div class="record-actions">${actionForm(`/routes/${encodeURIComponent(route.id)}/toggle`, session, route.enabled ? "Disable" : "Enable", { className: "button-secondary" })}${actionForm(`/routes/${encodeURIComponent(route.id)}/remove`, session, "Remove", { kind: "danger", confirm: "Remove this route?" })}</div></article>`;
    })
    .join("");
  const availableDestinations = destinations.filter(
    (destination) =>
      destination.enabled && !routes.some((route) => route.destinationId === destination.id),
  );
  const itemRows = itemPage.items
    .map((item) => itemPreview(item, subscription.title || subscription.sourceUrl))
    .join("");
  const nextItems = itemPage.nextCursor
    ? link(
        `/subscriptions/${encodeURIComponent(id)}?itemsCursor=${encodeURIComponent(itemPage.nextCursor)}`,
        "較舊內容",
        "button-secondary",
      )
    : "";
  const healthError = subscription.lastError
    ? `<div class="panel-error" role="alert"><strong>上次輪詢錯誤</strong><span>${displayText(subscription.lastError, 600)}</span></div>`
    : "";
  return `${heading("來源／詳情", truncate(subscription.title || subscription.sourceUrl, 100), "查看這個來源的健康狀態、路由目的地與最新內容。", `${actionForm(`/subscriptions/${encodeURIComponent(id)}/${subscription.enabled ? "pause" : "resume"}`, session, subscription.enabled ? "暫停來源" : "恢復來源", { className: "button-secondary" })}${pollAction(subscription, id, session, "button", "立即輪詢")}`)}
  <div class="detail-layout"><div class="stack"><section class="panel"><div class="section-title"><h2>來源健康度</h2>${statusPill(subscription.enabled ? "enabled" : "disabled", subscription.enabled ? "active" : "paused")}</div>${healthError}<dl class="key-value"><dt>來源 URL</dt><dd>${displayUrl(subscription.sourceUrl)}</dd><dt>來源類型</dt><dd>${adapterLabel(subscription.adapter)}</dd><dt>運作方式</dt><dd>${scheduleLabel(subscription)}</dd><dt>上次輪詢</dt><dd>${formatDate(subscription.lastPolledAt)}</dd><dt>上次成功</dt><dd>${formatDate(subscription.lastSuccessAt)}</dd><dt>下次輪詢</dt><dd>${formatDate(subscription.nextPollAt)}</dd><dt>失敗次數</dt><dd>${formatNumber(subscription.consecutiveFailures)}</dd></dl></section><section class="panel"><div class="section-title"><h2>最近內容</h2><span class="panel-note">${formatNumber(itemPage.items.length)} 筆</span></div>${itemRows || emptyState("還沒有內容", "下一次成功的輪詢會將新內容放進時間軸。")}${nextItems ? `<div class="button-row" style="margin-top:1rem">${nextItems}</div>` : ""}</section></div><aside class="stack"><section class="panel"><div class="section-title"><h2>路由</h2><span class="panel-note">${formatNumber(routes.length)} 條</span></div>${routeRows || `<p class="panel-note">還沒有路由。請在下方新增投遞目的地。</p>`}${availableDestinations.length === 0 ? "" : `<form class="stack" style="margin-top:1rem" method="post" action="/routes/create" data-loading>${csrfField(session)}<input type="hidden" name="subscriptionId" value="${escapeHtml(subscription.id)}"><div class="field"><label for="route-destination">新增目的地</label><select id="route-destination" name="destinationId">${availableDestinations.map((destination) => `<option value="${escapeHtml(destination.id)}">${displayText(destination.destinationKey, 100)}</option>`).join("")}</select></div><button class="button" type="submit">新增路由</button></form>`}</section><section class="panel"><h2 class="panel-title">危險區域</h2><p class="panel-note">移除來源會保留已收集的內容，但不會再出現在啟用中的清單。</p>${actionForm(`/subscriptions/${encodeURIComponent(id)}/remove`, session, "移除訂閱", { kind: "danger", confirm: "要移除這個訂閱嗎？已收集的內容仍會保留。" })}</section></aside></div>`;
}

function destinationsContent(app: CurioApplication, session: UiSession): string {
  const destinations = app.services.destinations.listPage(MAX_LIST_ITEMS).items;
  const routes = app.services.routes.listPage(MAX_LIST_ITEMS).items;
  const routeCounts = new Map<string, number>();
  for (const route of routes)
    routeCounts.set(route.destinationId, (routeCounts.get(route.destinationId) ?? 0) + 1);
  const subscriptions = new Map(
    app.services.subscriptions
      .list(MAX_LIST_ITEMS)
      .map((subscription) => [subscription.id, subscription]),
  );
  const rows = destinations
    .map(
      (destination) =>
        `<article class="record-row"><div><h3>${displayText(destination.destinationKey, 120)}</h3><div class="record-meta">${statusPill(destination.enabled ? "enabled" : "disabled", destination.enabled ? "enabled" : "paused")}<span>${buttonLabel(destination.kind)}</span><span>${formatNumber(routeCounts.get(destination.id) ?? 0)} 條路由</span></div><p>聊天室：${displayText((destination.config as { chatId?: unknown }).chatId ?? "隱藏", 100)}</p></div><div class="record-actions">${actionForm(`/destinations/${encodeURIComponent(destination.id)}/verify`, session, "驗證", { className: "button-secondary" })}${actionForm(`/destinations/${encodeURIComponent(destination.id)}/toggle`, session, destination.enabled ? "停用" : "啟用", { className: "button-secondary" })}</div></article>`,
    )
    .join("");
  const routeRows = routes
    .map((route) => {
      const subscription = subscriptions.get(route.subscriptionId);
      const destination = destinations.find((item) => item.id === route.destinationId);
      return `<article class="record-row"><div><h3>${displayText(subscription?.title || subscription?.sourceUrl || route.subscriptionId, 120)}</h3><div class="record-meta"><span>→ ${displayText(destination?.destinationKey || route.destinationId, 100)}</span>${statusPill(route.enabled ? "enabled" : "disabled", route.enabled ? "enabled" : "paused")}</div></div><div class="record-actions">${link(`/subscriptions/${encodeURIComponent(route.subscriptionId)}`, "開啟來源", "button-secondary")}${actionForm(`/routes/${encodeURIComponent(route.id)}/toggle`, session, route.enabled ? "Disable" : "Enable", { className: "button-secondary" })}${actionForm(`/routes/${encodeURIComponent(route.id)}/remove`, session, "Remove", { kind: "danger", confirm: "Remove this route?" })}</div></article>`;
    })
    .join("");
  return `${heading("出口／路由", "目的地與路由", "驗證 Telegram 目的地、切換啟用狀態，並決定各來源要送到哪裡。", "")}
  <div class="detail-layout"><section class="panel"><div class="section-title"><h2>目的地</h2><span class="panel-note">${formatNumber(destinations.length)} 個已設定</span></div>${rows || emptyState("還沒有目的地", "請先建立 Telegram 目的地，再新增路由。")}</section><aside class="panel"><div class="section-title"><h2>新增目的地</h2></div><form class="stack" method="post" action="/destinations/create" data-loading>${csrfField(session)}<div class="field"><label for="destination-key">名稱</label><input id="destination-key" name="destinationKey" placeholder="reading-room" required><span class="field-hint">本機使用的名稱，不是 Bot token。</span></div><div class="field"><label for="destination-chat-id">Telegram 聊天室 ID</label><input id="destination-chat-id" name="chatId" placeholder="@channel 或數字 ID" required><span class="field-hint">會儲存在目的地設定；Bot token 只留在伺服器端。</span></div><button class="button" type="submit">新增 Telegram 目的地</button></form></aside></div>
  <section class="panel" style="margin-top:1.2rem"><div class="section-title"><h2>路由圖</h2><span class="panel-note">${formatNumber(routes.length)} 條路由</span></div>${routeRows || emptyState("還沒有路由", "開啟訂閱後，將它連到啟用中的目的地。")}</section>`;
}

function deliveriesContent(app: CurioApplication, session: UiSession, url: URL): string {
  const rawStatus = url.searchParams.get("status") ?? "all";
  const status = rawStatus === "all" ? undefined : (rawStatus as DeliveryStatus);
  if (status && !DELIVERY_STATUSES.includes(status))
    throw new AppError("validation", "invalid_status", "投遞狀態無效");
  const deliveries = app.services.deliveries.list(status, MAX_LIST_ITEMS);
  const destinations = new Map(
    app.services.destinations
      .listPage(MAX_LIST_ITEMS)
      .items.map((destination) => [destination.id, destination]),
  );
  const rows = deliveries
    .map((delivery) => {
      const attempts = app.deliveryRepository.listAttempts(delivery.id);
      const destination = destinations.get(delivery.destinationId);
      const attemptsHtml =
        attempts.length === 0
          ? `<p class="panel-note">還沒有投遞嘗試。</p>`
          : `<div class="record-list">${attempts.map((attempt) => `<div class="record-row"><div><h3>第 ${formatNumber(attempt.attempt)} 次嘗試 · ${buttonLabel(attempt.outcome)}</h3><p>${displayText(attempt.error || "沒有錯誤", 180)}</p></div><span class="record-meta">${formatDate(attempt.finishedAt)}</span></div>`).join("")}</div>`;
      return `<article class="panel"><div class="record-row"><div><h3>${statusPill(delivery.status, delivery.status)} · ${displayText(destination?.destinationKey || delivery.destinationId, 100)}</h3><div class="record-meta"><span>${formatNumber(delivery.attemptCount)} 次嘗試</span><span>建立於 ${formatDate(delivery.createdAt)}</span>${delivery.itemId ? `<span class="code-note">內容 ${displayText(delivery.itemId, 50)}</span>` : ""}</div><p>${displayText(delivery.lastError || "沒有投遞錯誤", 240)}</p></div><div class="record-actions">${delivery.status === "uncertain" || delivery.status === "permanent_failure" ? actionForm(`/deliveries/${encodeURIComponent(delivery.id)}/retry`, session, "重試投遞", { className: "button" }) : ""}</div></div><details><summary>嘗試紀錄（${formatNumber(attempts.length)}）</summary>${attemptsHtml}</details></article>`;
    })
    .join("");
  return `${heading("寄件匣／復原", "投遞", "查看待確認或永久失敗的投遞、檢查嘗試紀錄，只重試你已確認的項目。", "")}
  <form class="toolbar" method="get" action="/deliveries"><div class="field field-small"><label for="delivery-status">狀態</label><select id="delivery-status" name="status"><option value="all"${rawStatus === "all" ? " selected" : ""}>全部</option>${DELIVERY_STATUSES.map((value) => `<option value="${value}"${rawStatus === value ? " selected" : ""}>${statusLabel(value)}</option>`).join("")}</select></div><button class="button" type="submit">篩選</button></form>
  <section class="stack" aria-label="投遞清單">${rows || emptyState("這個檢視沒有投遞", "成功的投遞與失敗紀錄會在輪詢後出現。")}</section>`;
}

function legalContent(kind: "privacy" | "terms"): string {
  if (kind === "privacy") {
    return `${heading("使用規則", "隱私", "Curio 設計給一位信任的操作者，在一台伺服器上使用。", "")}
    <section class="panel"><h2 class="panel-title">留在伺服器端的資料</h2><p class="panel-note">Bot token、webhook secret 與 X session cookie 只由伺服器程序讀取。管理介面不會將它們放進 HTML、前端 JavaScript 或瀏覽器儲存空間。來源標題、URL 與投遞錯誤都會在呈現前做 HTML escaping。</p><h2 class="panel-title">操作提醒</h2><p class="panel-note">SQLite 資料庫是系統的唯一資料來源。請像保護憑證一樣保護資料庫檔案與執行環境檔案。</p></section>`;
  }
  return `${heading("使用規則", "使用條款", "這是個人 Curio 實例的簡短使用約定。", "")}
  <section class="panel"><h2 class="panel-title">使用方式</h2><p class="panel-note">只使用你有權限存取的來源與目的地。輪詢與 Telegram 投遞可能產生外部流量與訊息。</p><h2 class="panel-title">復原</h2><p class="panel-note">重試前請先檢查待確認的投遞。即使 Telegram 已收到訊息，回應遺失時仍可能造成重複訊息。</p></section>`;
}

const FORM_FIELD_LABELS: Record<string, string> = {
  url: "URL",
  candidate: "來源候選",
  destinationId: "投遞目的地",
  intervalMinutes: "輪詢間隔",
  backfillLimit: "初始回填",
  destinationKey: "目的地名稱",
  chatId: "聊天室 ID",
};

function formFieldLabel(name: string): string {
  return FORM_FIELD_LABELS[name] ?? name;
}

function parseFormString(form: FormData, name: string, required = true): string {
  const value = form.get(name);
  if (value === null && !required) return "";
  if (typeof value !== "string" || (required && !value.trim())) {
    throw new AppError("validation", "invalid_field", `${formFieldLabel(name)}為必填欄位`);
  }
  return value.trim();
}

function parseFormInt(form: FormData, name: string, fallback?: number): number {
  const raw = form.get(name);
  if (raw === null && fallback !== undefined) return fallback;
  if (typeof raw !== "string" || !/^\d+$/u.test(raw))
    throw new AppError("validation", "invalid_field", `${formFieldLabel(name)}必須是整數`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value))
    throw new AppError("validation", "invalid_field", `${formFieldLabel(name)}必須是整數`);
  return value;
}

function formCandidate(form: FormData): SubscriptionCandidate {
  const raw = parseFormString(form, "candidate");
  let candidate: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("candidate must be an object");
    candidate = parsed as Record<string, unknown>;
  } catch {
    throw new AppError("validation", "invalid_candidate", "來源候選無效");
  }
  const adapter = typeof candidate.adapter === "string" ? candidate.adapter : "";
  const format = typeof candidate.format === "string" ? candidate.format : "";
  const discoveredVia = typeof candidate.discoveredVia === "string" ? candidate.discoveredVia : "";
  if (
    adapter !== "rss" &&
    adapter !== "x" &&
    adapter !== "html" &&
    adapter !== "youtube" &&
    adapter !== "telegram" &&
    adapter !== "telegram_html"
  )
    throw new AppError("validation", "invalid_candidate", "來源 adapter 無效");
  if (
    format !== "rss" &&
    format !== "atom" &&
    format !== "rdf" &&
    format !== "x" &&
    format !== "html" &&
    format !== "youtube" &&
    format !== "telegram"
  )
    throw new AppError("validation", "invalid_candidate", "來源格式無效");
  if (discoveredVia !== "direct" && discoveredVia !== "html-link")
    throw new AppError("validation", "invalid_candidate", "來源探索方式無效");
  const sourceUrl = typeof candidate.sourceUrl === "string" ? candidate.sourceUrl.trim() : "";
  const sourceKey = typeof candidate.sourceKey === "string" ? candidate.sourceKey.trim() : "";
  if (!sourceUrl || !sourceKey)
    throw new AppError("validation", "invalid_candidate", "來源 URL 無效");
  return {
    adapter,
    format,
    sourceUrl,
    sourceKey,
    title:
      typeof candidate.title === "string" && candidate.title.trim() ? candidate.title.trim() : null,
    discoveredVia,
  };
}

function findRoute(
  app: CurioApplication,
  subscriptionId: string,
  destinationId: string,
): Route | null {
  let cursor: string | null = null;
  while (true) {
    const page = app.services.routes.listPage(
      MAX_LIST_ITEMS,
      subscriptionId,
      cursor ? decodeCursor(cursor) : undefined,
    );
    const route = page.items.find((item) => item.destinationId === destinationId);
    if (route) return route;
    if (!page.nextCursor) return null;
    cursor = page.nextCursor;
  }
}

function ensureRoute(app: CurioApplication, input: NewRoute): void {
  const existing = findRoute(app, input.subscriptionId, input.destinationId);
  if (existing) {
    if (!existing.enabled) app.services.routes.update(existing.id, { enabled: true });
    return;
  }
  try {
    app.services.routes.create(input);
  } catch (error) {
    const appError = toAppError(error);
    if (appError.code !== "route_exists") throw error;
    const concurrent = findRoute(app, input.subscriptionId, input.destinationId);
    if (!concurrent) throw error;
    if (!concurrent.enabled) app.services.routes.update(concurrent.id, { enabled: true });
  }
}

export type UiHandler = (request: Request) => Promise<Response>;

export function createUiHandler(app: CurioApplication, options: UiHandlerOptions = {}): UiHandler {
  const now = options.now ?? Date.now;
  const sessions = new Map<string, UiSession>();

  function pruneSessions(timestamp: number): void {
    for (const [id, session] of sessions) {
      if (session.expiresAt <= timestamp) sessions.delete(id);
    }
    if (sessions.size > 1_000) {
      const oldest = [...sessions.entries()]
        .sort((left, right) => left[1].expiresAt - right[1].expiresAt)
        .slice(0, sessions.size - 1_000);
      for (const [id] of oldest) sessions.delete(id);
    }
  }

  function sessionFor(
    request: Request,
    create: boolean,
  ): { id: string; session: UiSession; isNew: boolean } | null {
    const timestamp = now();
    pruneSessions(timestamp);
    const cookie = getCookie(request, "curio_session");
    if (cookie) {
      const existing = sessions.get(cookie);
      if (existing && existing.expiresAt > timestamp) {
        existing.expiresAt = timestamp + SESSION_TTL_MS;
        return { id: cookie, session: existing, isNew: false };
      }
    }
    if (!create) return null;
    const id = randomToken();
    const session = { csrf: randomToken(), expiresAt: timestamp + SESSION_TTL_MS };
    sessions.set(id, session);
    return { id, session, isNew: true };
  }

  function sessionCookie(id: string): string {
    return `curio_session=${id}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1_000)}; HttpOnly; Secure; SameSite=Lax`;
  }

  function htmlResponse(
    html: string,
    session: { id: string; isNew: boolean },
    status = 200,
  ): Response {
    const headers = new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
    });
    if (session.isNew) headers.set("set-cookie", sessionCookie(session.id));
    return new Response(html, { status, headers });
  }

  function redirectResponse(
    request: Request,
    location: string,
    session: { id: string; isNew: boolean },
  ): Response {
    const headers = new Headers({
      location: new URL(location, request.url).toString(),
      "cache-control": "no-store",
    });
    if (session.isNew) headers.set("set-cookie", sessionCookie(session.id));
    return new Response(null, { status: 303, headers });
  }

  function flashFromUrl(url: URL): Flash | undefined {
    const notice = url.searchParams.get("notice");
    return notice ? NOTICE_MESSAGES[notice] : undefined;
  }

  async function renderPath(request: Request, session: UiSession, flash?: Flash): Promise<string> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/")
      return renderShell("Dashboard", "dashboard", dashboardContent(app, session), session, flash);
    if (url.pathname === "/privacy")
      return renderShell("Privacy", "", legalContent("privacy"), session, flash);
    if (url.pathname === "/terms")
      return renderShell("Terms", "", legalContent("terms"), session, flash);
    if (url.pathname === "/subscriptions")
      return renderShell(
        "Subscriptions",
        "subscriptions",
        subscriptionsContent(app, session, url),
        session,
        flash,
      );
    if (url.pathname === "/subscriptions/new")
      return renderShell(
        "Add subscription",
        "subscriptions",
        newSubscriptionContent(
          app,
          session,
          undefined,
          flash?.kind === "error" ? flash.text : undefined,
        ),
        session,
        flash,
      );
    if (segments[0] === "subscriptions" && segments.length === 2) {
      return renderShell(
        "Subscription detail",
        "subscriptions",
        subscriptionDetailContent(app, session, safePathSegment(segments[1] as string), url),
        session,
        flash,
      );
    }
    if (url.pathname === "/destinations")
      return renderShell(
        "Destinations",
        "destinations",
        destinationsContent(app, session),
        session,
        flash,
      );
    if (url.pathname === "/deliveries")
      return renderShell(
        "Deliveries",
        "deliveries",
        deliveriesContent(app, session, url),
        session,
        flash,
      );
    throw new AppError("not_found", "not_found", "找不到這個頁面");
  }

  async function renderFailure(
    request: Request,
    session: { id: string; session: UiSession; isNew: boolean },
    error: unknown,
    fallbackPath: string,
  ): Promise<Response> {
    const appError = toAppError(error);
    const message =
      appError.kind === "unexpected"
        ? "目前無法完成這個操作，請稍後再試。"
        : sanitizeErrorMessage(appError.message);
    let content: string;
    try {
      const target = new URL(fallbackPath, request.url);
      content = await renderPath(new Request(target, { method: "GET" }), session.session, {
        kind: "error",
        text: message,
      });
    } catch {
      content = renderShell(
        "Error",
        "",
        `<section class="panel-error" role="alert"><strong>目前無法完成這個操作</strong><span>${buttonLabel(message)}</span></section>`,
        session.session,
        { kind: "error", text: message },
      );
    }
    return htmlResponse(content, session, statusForUiError(appError));
  }

  function statusForUiError(error: AppError): number {
    if (error.kind === "validation") return 400;
    if (error.kind === "not_found") return 404;
    if (error.kind === "conflict") return 409;
    return 500;
  }

  async function mutate(
    path: string,
    form: FormData,
    session: UiSession,
  ): Promise<{ location: string } | { html: string }> {
    if (path === "/subscriptions/probe") {
      const url = parseFormString(form, "url");
      const result = await app.services.probe.probe(url);
      return {
        html: renderShell(
          "Probe candidates",
          "subscriptions",
          newSubscriptionContent(app, session, { result }),
          session,
        ),
      };
    }
    if (path === "/subscriptions/create") {
      const candidate = formCandidate(form);
      const destinationId = parseFormString(form, "destinationId");
      const destination = app.services.destinations.get(destinationId);
      if (!destination.enabled) {
        throw new AppError("conflict", "destination_disabled", "目的地已停用");
      }
      const intervalMinutes = parseFormInt(form, "intervalMinutes", 60);
      const backfillLimit = parseFormInt(form, "backfillLimit", 20);
      const selector = parseFormString(form, "selector", false);
      const notifyOnFirstPoll = form.get("notifyOnFirstPoll") === "true";
      const result = await app.services.subscriptions.followVerified({
        candidate,
        intervalMinutes,
        metadata: {
          backfillLimit,
          ...(selector ? { selector } : {}),
          ...(notifyOnFirstPoll ? { notifyOnFirstPoll: true } : {}),
        },
      });
      ensureRoute(app, { subscriptionId: result.subscription.id, destinationId, enabled: true });
      return {
        location: `/subscriptions/${encodeURIComponent(result.subscription.id)}?notice=subscription_created`,
      };
    }
    const segments = path.split("/").filter(Boolean);
    if (segments[0] === "subscriptions" && segments.length === 3) {
      const id = safePathSegment(segments[1] as string);
      const action = segments[2];
      if (action === "pause") {
        app.services.subscriptions.pause(id);
        return { location: `/subscriptions/${encodeURIComponent(id)}?notice=subscription_paused` };
      }
      if (action === "resume") {
        app.services.subscriptions.resume(id);
        return { location: `/subscriptions/${encodeURIComponent(id)}?notice=subscription_resumed` };
      }
      if (action === "poll") {
        await app.services.subscriptions.poll(id);
        return { location: `/subscriptions/${encodeURIComponent(id)}?notice=poll_complete` };
      }
      if (action === "remove") {
        app.services.subscriptions.remove(id);
        return { location: "/subscriptions?notice=subscription_removed" };
      }
    }
    if (path === "/destinations/create") {
      const destinationKey = parseFormString(form, "destinationKey");
      const chatId = parseFormString(form, "chatId");
      app.services.destinations.create({ destinationKey, kind: "telegram", config: { chatId } });
      return { location: "/destinations?notice=destination_created" };
    }
    if (segments[0] === "destinations" && segments.length === 3) {
      const id = safePathSegment(segments[1] as string);
      const action = segments[2];
      if (action === "toggle") {
        const destination = app.services.destinations.get(id);
        app.services.destinations.update(id, { enabled: !destination.enabled });
        return { location: "/destinations?notice=destination_toggled" };
      }
      if (action === "verify") {
        await app.services.destinations.verify(id);
        return { location: "/destinations?notice=destination_verified" };
      }
    }
    if (path === "/routes/create") {
      const input: NewRoute = {
        subscriptionId: parseFormString(form, "subscriptionId"),
        destinationId: parseFormString(form, "destinationId"),
        enabled: true,
      };
      app.services.routes.create(input);
      return {
        location: `/subscriptions/${encodeURIComponent(input.subscriptionId)}?notice=route_created`,
      };
    }
    if (segments[0] === "routes" && segments.length === 3) {
      const id = safePathSegment(segments[1] as string);
      const action = segments[2];
      if (action === "toggle") {
        const route = app.services.routes.get(id);
        const updated = app.services.routes.update(id, { enabled: !route.enabled });
        return {
          location: `/subscriptions/${encodeURIComponent(updated.subscriptionId)}?notice=route_toggled`,
        };
      }
      if (action === "remove") {
        const route = app.services.routes.get(id);
        app.services.routes.remove(id);
        return {
          location: `/subscriptions/${encodeURIComponent(route.subscriptionId)}?notice=route_removed`,
        };
      }
    }
    if (segments[0] === "deliveries" && segments.length === 3 && segments[2] === "retry") {
      app.services.deliveries.retry(safePathSegment(segments[1] as string));
      return { location: "/deliveries?notice=delivery_retried" };
    }
    throw new AppError("not_found", "not_found", "找不到這個操作");
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!isValidUiPath(url.pathname) && request.method !== "POST") {
      const session = sessionFor(request, true);
      if (!session) return new Response("找不到這個頁面", { status: 404 });
      return htmlResponse(
        renderShell(
          "Not found",
          "",
          `<section class="panel-error" role="alert"><strong>找不到這個頁面</strong><span>回到總覽繼續整理你的來源。</span>${link("/", "回到總覽", "button")}</section>`,
          session.session,
        ),
        session,
        404,
      );
    }
    const session = sessionFor(request, request.method === "GET");
    if (!session) return new Response("工作階段已過期", { status: 403 });
    if (request.method === "GET") {
      try {
        return htmlResponse(await renderPath(request, session.session, flashFromUrl(url)), session);
      } catch (error) {
        const appError = toAppError(error);
        const content = renderShell(
          "Error",
          "",
          `<section class="panel-error" role="alert"><strong>頁面載入失敗</strong><span>${buttonLabel(appError.kind === "unexpected" ? "目前無法載入這個頁面。" : sanitizeErrorMessage(appError.message))}</span>${link("/", "回到總覽", "button")}</section>`,
          session.session,
          {
            kind: "error",
            text:
              appError.kind === "unexpected"
                ? "頁面載入失敗。"
                : sanitizeErrorMessage(appError.message),
          },
        );
        return htmlResponse(content, session, appError.kind === "not_found" ? 404 : 500);
      }
    }
    if (request.method !== "POST") return new Response("不允許的 HTTP 方法", { status: 405 });
    const contentLength = request.headers.get("content-length");
    if (
      contentLength &&
      /^\d+$/u.test(contentLength) &&
      Number(contentLength) > MAX_FORM_BODY_BYTES
    ) {
      return htmlResponse(
        renderShell(
          "Request too large",
          "",
          `<section class="panel-error" role="alert"><strong>表單太大</strong><span>請縮短輸入後再試。</span></section>`,
          session.session,
          { kind: "error", text: "表單太大。" },
        ),
        session,
        413,
      );
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return htmlResponse(
        renderShell(
          "Invalid form",
          "",
          `<section class="panel-error" role="alert"><strong>表單格式無效</strong><span>請重新載入頁面後再試。</span></section>`,
          session.session,
          { kind: "error", text: "表單格式無效。" },
        ),
        session,
        400,
      );
    }
    const csrf = form.get("csrf");
    if (typeof csrf !== "string" || !constantTimeEqual(csrf, session.session.csrf)) {
      return htmlResponse(
        renderShell(
          "Forbidden",
          "",
          `<section class="panel-error" role="alert"><strong>安全驗證失敗</strong><span>請重新載入頁面後再試。</span></section>`,
          session.session,
          { kind: "error", text: "安全驗證失敗。" },
        ),
        session,
        403,
      );
    }
    try {
      const result = await mutate(url.pathname, form, session.session);
      if ("html" in result) return htmlResponse(result.html, session);
      return redirectResponse(request, result.location, session);
    } catch (error) {
      const fallback =
        url.pathname === "/subscriptions/probe"
          ? "/subscriptions/new"
          : url.pathname.startsWith("/subscriptions/")
            ? `/subscriptions/${url.pathname.split("/")[2]}`
            : url.pathname.startsWith("/routes/")
              ? "/subscriptions"
              : url.pathname;
      return renderFailure(request, session, error, fallback);
    }
  };
}
