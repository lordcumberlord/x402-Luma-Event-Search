export type DiscordCallbackData = {
  applicationId: string;
  channelId: string;
  guildId: string | null;
  lookbackMinutes: number;
  paymentMessageId?: string;
  expiresAt: number;
};

export type TelegramCallbackData = {
  chatId: number;
  threadId?: number | null;
  messageId?: number | null;
  paymentMessageId?: number;
  username?: string | null;
  // For summarise command
  lookbackMinutes?: number;
  // For search_events command
  topic?: string;
  location?: string;
  expiresAt: number;
};

export type SearchState = {
  events: Array<{
    id: string;
    title: string;
    url: string;
    description?: string;
    location?: string;
    date?: string;
    attendeeCount?: number;
  }>;
  topic: string;
  location?: string;
  offset: number; // Current offset (0, 5, 10, etc.)
  expiresAt: number; // Expire after 1 hour
};

export const pendingDiscordCallbacks = new Map<string, DiscordCallbackData>();
export const pendingTelegramCallbacks = new Map<string, TelegramCallbackData>();
// Store search state per chatId for pagination
export const searchState = new Map<number, SearchState>();

