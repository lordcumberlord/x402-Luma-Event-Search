import { Bot, InlineKeyboard } from "grammy";
import { validateLookback } from "./lookback";
import { PAYMENT_CALLBACK_EXPIRY_MS } from "./constants";
import { pendingTelegramCallbacks, searchState } from "./pending";
import { addTelegramMessage, updateTelegramMessageReactions } from "./telegramStore";

const DEFAULT_LOOKBACK_MINUTES = 60;

function extractLookback(text: string | undefined) {
  if (!text) return DEFAULT_LOOKBACK_MINUTES;
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) return DEFAULT_LOOKBACK_MINUTES;
  const candidate = parts[1];
  const result = validateLookback(candidate);
  if ("error" in result) {
    return result;
  }
  return result.minutes;
}

export function createTelegramBot(options: {
  token: string;
  baseUrl: string;
}) {
  const bot = new Bot(options.token);

  bot.catch((err) => {
    console.error("[telegram] polling error", err.error ?? err);
  });

  bot.on("message", async (ctx, next) => {
    const msg = ctx.message;
    if (!msg) {
      return next();
    }
    const chatId = msg.chat?.id;
    const text = "text" in msg ? msg.text ?? "" : "";
    // Don't store command messages - they shouldn't be included in summaries
    const trimmed = text.trim();
    if (chatId && trimmed.length > 0 && !trimmed.startsWith("/")) {
      addTelegramMessage(chatId, {
        messageId: msg.message_id,
        text,
        timestampMs: (msg.date ?? Math.floor(Date.now() / 1000)) * 1000,
        authorId: ctx.from?.id,
        authorUsername: ctx.from?.username ?? null,
        authorDisplay: ctx.from?.first_name
          ? `${ctx.from.first_name}${ctx.from.last_name ? " " + ctx.from.last_name : ""}`
          : ctx.from?.username ?? null,
        replyToMessageId:
          msg.reply_to_message && "message_id" in msg.reply_to_message
            ? msg.reply_to_message.message_id
            : undefined,
      });
    }
    return next();
  });

  // Handle message reactions - track reaction counts for messages
  bot.on("message_reaction", async (ctx) => {
    try {
      const update = ctx.update.message_reaction;
      if (!update) return;
      
      const chatId = update.chat.id;
      const messageId = update.message_id;
      
      // Get current reactions count from the update
      // Telegram provides reaction_counts in the message_reaction update
      const reactionCounts = (update as any).reaction_counts || [];
      const totalReactions = reactionCounts.reduce((sum: number, rc: any) => sum + (rc.count || 0), 0);
      
      if (totalReactions > 0) {
        updateTelegramMessageReactions(chatId, messageId, totalReactions);
      } else {
        // No reactions - set to 0
        updateTelegramMessageReactions(chatId, messageId, 0);
      }
    } catch (error) {
      console.warn("[telegram] Error handling message reaction:", error);
    }
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Hey! I'm the Luma Event Search Bot. Use /search_events to find events:\n\n" +
      "• /search_events on <topic> - Search events by topic (e.g., crypto, AI)\n" +
      "• /search_events in <place> - Search events by city (e.g., London, Dubai)\n" +
      "• /search_events on <topic> in <place> - Search events by topic in a specific city\n\n" +
      "Examples:\n" +
      "• /search_events on crypto\n" +
      "• /search_events in London\n" +
      "• /search_events on AI in London\n\n" +
      "You will be provided with up to 5 events in your given search.\n\n" +
      "• /more - receive 5 more"
    );
  });

  bot.command("summarise", async (ctx) => {
    const lookbackResult = extractLookback(ctx.message?.text);

    if (typeof lookbackResult === "object" && "error" in lookbackResult) {
      await ctx.reply(
        `❌ ${lookbackResult.error}\n\nUsage: /summarise 60`
      );
      return;
    }

    const lookbackMinutes = lookbackResult;
    const chatId = ctx.chat?.id;

    if (!chatId) {
      await ctx.reply("❌ Could not determine chat id.");
      return;
    }

    const token = `${chatId}:${Date.now()}:${crypto.randomUUID()}`;

    const callbackParam = encodeURIComponent(token);
    const url = new URL("/pay", options.baseUrl);
    url.searchParams.set("source", "telegram");
    url.searchParams.set("telegram_callback", callbackParam);
    url.searchParams.set("chatId", String(chatId));
    url.searchParams.set("lookbackMinutes", String(lookbackMinutes));

    const keyboard = new InlineKeyboard().url(
      "Pay $0.10 via x402",
      url.toString()
    );

    const paymentMessage = await ctx.reply(
      `🪙 *Payment Required*\n\n` +
        `We'll summarise the last ${lookbackMinutes} minutes of this chat.`,
      {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      }
    );

    pendingTelegramCallbacks.set(token, {
      chatId,
      threadId: ctx.message && "message_thread_id" in ctx.message ? ctx.message.message_thread_id : undefined,
      messageId: ctx.message?.message_id,
      username: ctx.from?.username,
      lookbackMinutes: typeof lookbackMinutes === "number" ? lookbackMinutes : undefined,
      paymentMessageId: paymentMessage.message_id,
      expiresAt: Date.now() + PAYMENT_CALLBACK_EXPIRY_MS,
    });
  });

  function parseSearchEventsCommand(text: string | undefined): 
    | { topic: string; location?: string } 
    | { error: string } {
    if (!text) {
      return { error: "Usage: /search_events on <topic> [in <city>]" };
    }

    const trimmed = text.trim();
    const parts = trimmed.split(/\s+/);

    // Check for /search_events command
    if (parts.length < 3) {
      return { error: "Usage: /search_events on <topic> [in <city>]" };
    }

    // Find "on" keyword (required)
    let onIndex = -1;
    let inIndex = -1;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].toLowerCase();
      if (part === "on" && onIndex === -1) {
        onIndex = i;
      } else if (part === "in" && inIndex === -1) {
        inIndex = i;
      }
    }

    if (onIndex === -1) {
      return { error: "Usage: /search_events on <topic> [in <city>]" };
    }

    // Extract topic (everything after "on" until "in" or end)
    const topicEndIndex = inIndex !== -1 ? inIndex : parts.length;
    const topicParts = parts.slice(onIndex + 1, topicEndIndex);
    const topic = topicParts.join(" ").trim();

    if (!topic) {
      return { error: "Please provide a topic. Usage: /search_events on <topic> [in <city>]" };
    }

    // Extract location (everything after "in" if present)
    let location: string | undefined;
    if (inIndex !== -1 && inIndex + 1 < parts.length) {
      const locationParts = parts.slice(inIndex + 1);
      location = locationParts.join(" ").trim();
      if (!location) {
        return { error: "Please provide a city name after 'in'. Usage: /search_events on <topic> in <city>" };
      }
    }

    return { topic, location };
  }

  bot.command("search_events", async (ctx) => {
    const parseResult = parseSearchEventsCommand(ctx.message?.text);

    if ("error" in parseResult) {
      await ctx.reply(
        `❌ ${parseResult.error}\n\n` +
        `Examples:\n` +
        `• /search_events on crypto\n` +
        `• /search_events on AI in London\n` +
        `• /search_events on crypto in San Francisco`
      );
      return;
    }

    const { topic, location } = parseResult;
    const chatId = ctx.chat?.id;

    if (!chatId) {
      await ctx.reply("❌ Could not determine chat id.");
      return;
    }

    const token = `${chatId}:${Date.now()}:${crypto.randomUUID()}`;

    const callbackParam = encodeURIComponent(token);
    const url = new URL("/pay", options.baseUrl);
    url.searchParams.set("source", "telegram");
    url.searchParams.set("telegram_callback", callbackParam);
    url.searchParams.set("chatId", String(chatId));
    url.searchParams.set("topic", topic);
    if (location) {
      url.searchParams.set("location", location);
    }

    const keyboard = new InlineKeyboard().url(
      "Pay $0.10 via x402",
      url.toString()
    );

    const searchDescription = location 
      ? `Searching for *${topic}* events in *${location}*`
      : `Searching for *${topic}* events`;

    const paymentMessage = await ctx.reply(
      `🪙 *Payment Required*\n\n${searchDescription}`,
      {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      }
    );

    pendingTelegramCallbacks.set(token, {
      chatId,
      threadId: ctx.message && "message_thread_id" in ctx.message ? ctx.message.message_thread_id : undefined,
      messageId: ctx.message?.message_id,
      username: ctx.from?.username,
      topic,
      location,
      paymentMessageId: paymentMessage.message_id,
      expiresAt: Date.now() + PAYMENT_CALLBACK_EXPIRY_MS,
    });
  });

  bot.command("more", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.reply("❌ Could not determine chat id.");
      return;
    }

    // Get the last search state for this chat
    const state = searchState.get(chatId);
    if (!state || state.expiresAt < Date.now()) {
      await ctx.reply(
        "❌ No recent search found. Please use /search_events first.\n\n" +
        "Example: /search_events on crypto in Dubai"
      );
      return;
    }

    // Check if there are more events
    const nextOffset = state.offset + 5;
    if (nextOffset >= state.events.length) {
      await ctx.reply("✅ You've seen all events from your last search. Try a new search!");
      return;
    }

    // Get the next 5 events
    const nextEvents = state.events.slice(nextOffset, nextOffset + 5);
    const { formatEventsForTelegram } = await import("./luma");
    const message = formatEventsForTelegram(nextEvents, state.events.length, nextOffset);

    // Update the offset
    state.offset = nextOffset;
    state.expiresAt = Date.now() + 60 * 60 * 1000; // Extend expiry by 1 hour

    await ctx.reply(message, { parse_mode: "Markdown" });
  });

  return bot;
}

