import type { CanonicalItem } from "../../domain/types.ts";

export interface XTweet {
  id: string;
  text: string;
  createdAt?: string;
  conversationId?: string;
  inReplyToStatusId?: string;
  author: { username: string; name: string };
  quotedTweet?: XTweet;
  media?: Array<{
    type?: string;
    url?: string;
    previewUrl?: string;
    videoUrl?: string;
    width?: number;
    height?: number;
  }>;
  article?: { title: string; previewText?: string };
}

export interface XbirdResult {
  ok: boolean;
  data?: XTweet[] | { tweets?: XTweet[]; nextCursor?: string };
  error?: { code?: string } | string;
}

export interface XbirdTimelineClient {
  userTweets(handle: string, count: number): Promise<XTweet[]>;
}

export interface NormalizedXPost {
  item: CanonicalItem;
  publishedAt: number;
}
