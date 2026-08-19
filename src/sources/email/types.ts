import type { Subscription } from "../../domain/types.ts";

export const EMAIL_SOURCE_KEY = "shared-inbox";

export interface EmailSourceConfig {
  address: string;
  webhookSecret: string;
}

export interface InboundEmail {
  recipient: string;
  messageId: string | null;
  from: string;
  subject: string | null;
  date: string | null;
  text: string | null;
  html: string | null;
  url: string | null;
  headers: Record<string, string>;
}

export interface EmailInbox {
  address: string;
  subscription: Subscription;
}

export interface EmailReceiveResult {
  subscriptionId: string;
  externalId: string;
  insertedItems: number;
  updatedItems: number;
}
