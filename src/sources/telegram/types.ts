export interface TelegramChannelChat {
  id: string;
  type: "channel";
  title: string | null;
  username: string | null;
}

export interface TelegramChannelPost {
  updateId: number;
  messageId: number;
  chat: TelegramChannelChat;
  date: number;
  editDate: number | null;
  text: string | null;
}

export interface TelegramChannelPostHandler {
  handleChannelPost(post: TelegramChannelPost): void | Promise<void>;
}
