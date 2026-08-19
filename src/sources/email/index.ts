export {
  EmailInboxUnavailableError,
  EmailRecipientMismatchError,
  EmailSourceAdapter,
} from "./adapter.ts";
export { EmailPayloadError, normalizeEmail, parseInboundEmail } from "./normalize.ts";
export type {
  EmailInbox,
  EmailReceiveResult,
  EmailSourceConfig,
  InboundEmail,
} from "./types.ts";
export { createEmailWebhookHandler, type EmailWebhookHandler } from "./webhook.ts";
