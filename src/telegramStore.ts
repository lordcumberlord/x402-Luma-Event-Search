export type TelegramStoredMessage = {
  messageId: number;
  text: string;
  timestampMs: number;
  authorId?: number;
  authorUsername?: string | null;
  authorDisplay?: string | null;
  replyToMessageId?: number;
};

const MAX_MESSAGES_PER_CHAT = 1000;

const messageStore = new Map<number, TelegramStoredMessage[]>();

export function addTelegramMessage(chatId: number, message: TelegramStoredMessage) {
  const existing = messageStore.get(chatId) ?? [];
  existing.push(message);
  if (existing.length > MAX_MESSAGES_PER_CHAT) {
    existing.splice(0, existing.length - MAX_MESSAGES_PER_CHAT);
  }
  messageStore.set(chatId, existing);
}

export function getTelegramMessages(chatId: number) {
  return messageStore.get(chatId) ?? [];
}

export function getTelegramMessagesWithin(chatId: number, lookbackMinutes: number) {
  const now = Date.now();
  const cutoff = now - lookbackMinutes * 60 * 1000;
  return getTelegramMessages(chatId).filter((msg) => msg.timestampMs >= cutoff);
}

export function clearTelegramMessages(chatId: number) {
  messageStore.delete(chatId);
}
