import { app, executeSummariseChat } from "./agent";
import { exact } from "x402/schemes";
import { findMatchingPaymentRequirements } from "x402/shared";
import { useFacilitator } from "x402/verify";
import { settleResponseHeader } from "x402/types";
import nacl from "tweetnacl";
import { MAX_LOOKBACK_MINUTES, validateLookback } from "./lookback";
import { PAYMENT_CALLBACK_EXPIRY_MS } from "./constants";
import {
  pendingDiscordCallbacks,
  pendingTelegramCallbacks,
} from "./pending";
import { createTelegramBot } from "./telegram";

const port = Number(process.env.PORT ?? 8080);
const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const DISCORD_API_DEFAULT_BASE = "https://discord.com/api/v10";

// Payment constants
const USDC_DECIMALS = 6;
const DEFAULT_PRICE_USDC = BigInt(50000); // 0.05 USDC (50000 / 10^6)
const EPHEMERAL_FLAG = 1 << 6;

function makeEphemeralResponse(message: string): Response {
  return Response.json({
    type: 4,
    data: {
      content: message,
      flags: EPHEMERAL_FLAG,
    },
  });
}

// Clean up expired callbacks every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of pendingDiscordCallbacks.entries()) {
    if (data.expiresAt < now) {
      pendingDiscordCallbacks.delete(token);
    }
  }
  for (const [token, data] of pendingTelegramCallbacks.entries()) {
    if (data.expiresAt < now) {
      pendingTelegramCallbacks.delete(token);
    }
  }
}, 30 * 60 * 1000);

// Discord signature verification using Ed25519
function verifyDiscordRequest(
  body: string,
  signature: string,
  timestamp: string
): boolean {
  if (!PUBLIC_KEY) {
    console.warn("[discord] DISCORD_PUBLIC_KEY not set, skipping signature verification");
    return false; // Don't allow if PUBLIC_KEY is required
  }

  try {
    // Convert hex strings to Uint8Arrays
    const publicKeyBytes = Uint8Array.from(
      Buffer.from(PUBLIC_KEY, "hex")
    );
    const signatureBytes = Uint8Array.from(
      Buffer.from(signature, "hex")
    );

    // Discord signs: timestamp + body
    const message = new TextEncoder().encode(timestamp + body);

    // Verify signature using Ed25519
    const isValid = nacl.sign.detached.verify(message, signatureBytes, publicKeyBytes);
    
    if (!isValid) {
      console.warn("[discord] Signature verification failed");
    }
    
    return isValid;
  } catch (error) {
    console.error("[discord] Signature verification error:", error);
    return false;
  }
}

// Handle Discord interactions
async function handleDiscordInteraction(req: Request): Promise<Response> {
  try {
    const signature = req.headers.get("x-signature-ed25519");
    const timestamp = req.headers.get("x-signature-timestamp");

    const body = await req.text();
    
    // Verify signature FIRST if PUBLIC_KEY is set (required for Discord verification)
    if (PUBLIC_KEY) {
      if (!signature || !timestamp) {
        console.warn("[discord] Missing signature headers");
        return Response.json({ error: "Missing signature headers" }, { status: 401 });
      }

      const isValid = verifyDiscordRequest(body, signature, timestamp);
      if (!isValid) {
        console.warn("[discord] Invalid signature");
        return Response.json({ error: "Invalid signature" }, { status: 401 });
      }
    } else {
      console.warn("[discord] DISCORD_PUBLIC_KEY not set - signature verification disabled");
    }
    
    // Parse interaction after signature verification
    let interaction;
    try {
      interaction = JSON.parse(body);
    } catch (e) {
      console.error("[discord] Failed to parse interaction body:", e);
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Handle PING (Discord's verification)
    if (interaction.type === 1) {
      console.log("[discord] Received PING, responding with PONG");
      return Response.json({ type: 1 });
    }

    // Handle APPLICATION_COMMAND
    if (interaction.type === 2) {
      const { name, options } = interaction.data || {};
      // channel_id and guild_id are at the interaction level, not in data
      const channel_id = interaction.channel_id || interaction.channel?.id;
      const guild_id = interaction.guild_id || interaction.guild?.id;

      if (name === "summarise") {
        // Get lookback minutes from options (default: 60)
        const lookbackOption = options?.find((opt: any) => opt.name === "minutes");
        const lookbackValidation = validateLookback(lookbackOption?.value ?? 60);

        if ("error" in lookbackValidation) {
          return makeEphemeralResponse(`❌ ${lookbackValidation.error}`);
        }

        const { minutes: lookbackMinutes } = lookbackValidation;

        // Validate required fields
        if (!channel_id) {
          console.error(`[discord] Missing channel_id in interaction:`, JSON.stringify(interaction, null, 2));
          const followupUrl = `${process.env.DISCORD_API_BASE_URL ?? DISCORD_API_DEFAULT_BASE}/webhooks/${interaction.application_id}/${interaction.token}`;
          await fetch(followupUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: "❌ Error: Could not determine channel ID from interaction.",
            }),
          });
          return Response.json({ error: "Missing channel_id" }, { status: 400 });
        }

        // Respond immediately with "thinking"
        const initialResponse = Response.json({
          type: 5, // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
        });

        // Process in background - route through x402 payment-enabled entrypoint
        (async () => {
          try {
          console.log(`[discord] Summarise request: channel=${channel_id}, guild=${guild_id}, minutes=${lookbackMinutes}`);

          const baseUrl =
            process.env.DISCORD_API_BASE_URL ?? DISCORD_API_DEFAULT_BASE;
          const followupUrl = `${baseUrl}/webhooks/${interaction.application_id}/${interaction.token}`;

          // Call the agent-kit entrypoint (which handles x402 payments)
          const agentBaseUrl = process.env.AGENT_URL || `https://x402-summariser-production.up.railway.app`;
          const entrypointUrl = `${agentBaseUrl}/entrypoints/summarise%20chat/invoke`;

          // Ensure channel_id is valid
          if (!channel_id || typeof channel_id !== "string" || channel_id.trim() === "") {
            throw new Error(`Invalid channel_id: ${channel_id}. Please try the command again.`);
          }
          // Make request to entrypoint (without payment headers - it will return payment instructions)
          const entrypointResponse = await fetch(entrypointUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              input: {
                channelId: channel_id.trim(),
                serverId: guild_id || undefined,
                lookbackMinutes,
              },
            }),
          });

          const responseData = await entrypointResponse.json();

          // Check for validation errors
          if (entrypointResponse.status === 400) {
            const errorMsg = responseData.error?.issues?.[0]?.message || responseData.error?.message || "Validation error";
            console.error(`[discord] Entrypoint validation error:`, responseData);
            await fetch(followupUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                content: `❌ **Validation Error**\n${errorMsg}\n\nIf this persists, please check Railway logs for details.`,
              }),
            });
            return;
          }

          // Log the response status for debugging
          console.log(`[discord] Entrypoint response status: ${entrypointResponse.status}`);

          // Check if payment is required (402 or payment_required error)
          // Also check if the response indicates payment was needed but wasn't provided
          let requiresPayment = 
            entrypointResponse.status === 402 || 
            responseData.error?.code === "payment_required" ||
            responseData.payment_required === true ||
            (entrypointResponse.headers.get("x-payment-required") === "true");

          // If we got a successful response but payment should be required, 
          // we need to enforce payment manually
          // Agent-kit may not enforce payment automatically for internal calls
          // For Discord commands, we should ALWAYS require payment via x402
          if (entrypointResponse.status === 200 && !requiresPayment) {
            console.log(`[discord] Entrypoint returned success without payment - enforcing payment requirement for Discord`);
            requiresPayment = true;
          }

          if (requiresPayment) {
            const callbackParam = encodeURIComponent(interaction.token);
            const paymentUrl = `${agentBaseUrl}/pay?channelId=${channel_id}&serverId=${guild_id || ""}&lookbackMinutes=${lookbackMinutes}&discord_callback=${callbackParam}`;
            
            // Get price from entrypoint config or default
            const price = process.env.ENTRYPOINT_PRICE || "0.05";
            const currency = process.env.PAYMENT_CURRENCY || "USDC";
            
            const paymentMessage = `💳 **Payment Required**

To summarise this channel, please pay **$${price} ${currency}** via x402.

🔗 **Pay & Summarise:** [Click here](${paymentUrl})

After payment, your summary will appear here automatically.`;

            let paymentMessageId: string | undefined;
            const followupResponse = await fetch(followupUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                content: paymentMessage,
              }),
            });

            if (!followupResponse.ok) {
              const errorText = await followupResponse.text();
              console.error(`[discord] Failed to send follow-up: ${followupResponse.status} ${errorText}`);
              return;
            }

            try {
              const followupData = await followupResponse.json();
              if (followupData && followupData.id) {
                paymentMessageId = String(followupData.id);
              }
            } catch (jsonError) {
              console.warn("[discord] Unable to parse follow-up response JSON", jsonError);
            }

            pendingDiscordCallbacks.set(interaction.token, {
              applicationId: interaction.application_id,
              channelId: channel_id,
              guildId: guild_id,
              lookbackMinutes,
              paymentMessageId,
              expiresAt: Date.now() + PAYMENT_CALLBACK_EXPIRY_MS,
            });
            return;
          }

          if (!entrypointResponse.ok) {
            throw new Error(`Entrypoint error: ${entrypointResponse.status} ${JSON.stringify(responseData)}`);
          }

          // Success - format and send result
          const output = responseData.output || responseData;
          let content = `**Summary**\n${output.summary || "No summary available"}\n\n`;
          
          console.log(`[discord] Summary completed: ${(output.summary || "").substring(0, 50)}...`);

          const followupResponse = await fetch(followupUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content,
            }),
          });

          if (!followupResponse.ok) {
            const errorText = await followupResponse.text();
            console.error(`[discord] Failed to send follow-up: ${followupResponse.status} ${errorText}`);
            throw new Error(`Failed to send response: ${followupResponse.status}`);
          }

          console.log(`[discord] Successfully sent summary response`);
        } catch (error: any) {
          console.error(`[discord] Error processing command:`, error);
          const errorMsg = error.message || "An error occurred";
          const baseUrl =
            process.env.DISCORD_API_BASE_URL ?? DISCORD_API_DEFAULT_BASE;
          const followupUrl = `${baseUrl}/webhooks/${interaction.application_id}/${interaction.token}`;

          try {
            const errorResponse = await fetch(followupUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                content: `❌ Error: ${errorMsg}`,
              }),
            });

            if (!errorResponse.ok) {
              const errorText = await errorResponse.text();
              console.error(`[discord] Failed to send error message: ${errorResponse.status} ${errorText}`);
            }
          } catch (fetchError) {
            console.error(`[discord] Failed to send error response:`, fetchError);
          }
        }
        })();

        return initialResponse;
      }
    }

    return Response.json({ error: "Unknown interaction type" }, { status: 400 });
  } catch (error: any) {
    console.error("[discord] Error handling interaction:", error);
    return Response.json(
      { error: "Internal server error", message: error?.message },
      { status: 500 }
    );
  }
}

// Handle Discord callback after payment
async function handleDiscordCallback(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { discord_token, result } = body;

    if (!discord_token) {
      return Response.json({ error: "Missing discord_token" }, { status: 400 });
    }

    // Decode the token (it was URL-encoded when passed in the payment URL)
    const decodedToken = decodeURIComponent(discord_token);
    
    const callbackData = pendingDiscordCallbacks.get(decodedToken);
    if (!callbackData) {
      console.error(`[discord-callback] Token not found or expired: ${decodedToken.substring(0, 30)}...`);
      return Response.json({ error: "Invalid or expired callback token" }, { status: 404 });
    }

    // Remove from pending immediately
    pendingDiscordCallbacks.delete(decodedToken);

    // Prepare Discord posting - do it with a timeout so we don't block too long
    const baseUrl = process.env.DISCORD_API_BASE_URL ?? DISCORD_API_DEFAULT_BASE;
    const followupUrl = `${baseUrl}/webhooks/${callbackData.applicationId}/${decodedToken}`;

    const output = result?.output || result;
    
    // Extract summary, filtering out any payment-related messages that might have leaked in
    let summary = output?.summary || "No summary available";
    
    // Fix greeting if it appears as a bullet point - remove bullet and place on new line
    summary = summary.replace(/^•\s*(Good (morning|afternoon|evening)![^\n]*)/m, "$1");
    
    // Remove any duplicate greeting lines (keep only the first one)
    const greetingPattern = /^(Good (morning|afternoon|evening)![^\n]*)/m;
    let firstGreetingIndex = -1;
    summary = summary.replace(new RegExp(greetingPattern.source, "gm"), (match: string, offset: number) => {
      if (firstGreetingIndex === -1) {
        // Keep the first greeting
        firstGreetingIndex = offset;
        return match;
      } else {
        // Remove subsequent duplicates
        return "";
      }
    }).replace(/\n\n+/g, "\n\n").trim(); // Clean up extra blank lines
    
    // Remove "Hello!" style greetings (should use time-based greetings)
    summary = summary.replace(/^Hello!\s*Here is what happened[^\n]*\n?/im, "");
    
    // Remove payment-related prefixes that might have been included in the summary
    summary = summary
      .replace(/^✅\s*Payment (Confirmed|Required)\s*\n?\n?/gim, "") // Remove "✅ Payment Confirmed" or "✅ Payment Required" at start
      .replace(/💳\s*\*\*Payment Required\*\*[\s\S]*?automatically\./gi, "")
      .replace(/🔗\s*\*\*Pay.*?\n/gi, "")
      .replace(/https?:\/\/[^\s]*pay[^\s]*/gi, "")
      .replace(/To summarise this channel, please pay.*?via x402\./gi, "")
      .trim();
    
    // Remove timestamps if they somehow got through
    summary = summary
      .replace(/\[\d{4}-\d{2}-\d{2}T[^\]]+\]/g, "") // ISO timestamps
      .replace(/\[[^\]]*\d{4}[^\]]*\]/g, "") // Any bracketed timestamps
      .replace(/x402 Summariser[^\n]*\n?/gi, "") // Remove "x402 Summariser:" prefix
      .trim();
    
    if (!summary) {
      summary = "No material updates or chatter in this window.";
    }
    
    const content = summary.trim();
    
    // Send to Discord - try to complete it quickly, but don't block forever
    // Use Promise.race with a timeout so we return within 5 seconds max
    try {
      await Promise.race([
        (async () => {
          const followupResponse = await fetch(followupUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content,
            }),
          });

          if (!followupResponse.ok) {
            const errorText = await followupResponse.text();
            console.error(`[discord] Failed to send callback result: ${followupResponse.status} ${errorText}`);
            return;
          }

          if (callbackData.paymentMessageId) {
            const editUrl = `${followupUrl}/messages/${callbackData.paymentMessageId}`;
            const editResponse = await fetch(editUrl, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                content: "✅ Payment received. Summary posted below.",
              }),
            });

            if (!editResponse.ok) {
              const editError = await editResponse.text();
              console.warn(`[discord] Failed to edit payment message: ${editResponse.status} ${editError}`);
            }
          }

          console.log(`[discord] Successfully sent callback result to Discord`);
        })(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Discord API timeout")), 5000)
        )
      ]);
    } catch (error: any) {
      // If timeout or error, log it but still return success
      // The background task will continue if it hasn't been garbage collected
      console.error("[discord] Error or timeout posting to Discord:", error);
      // Fire off a background task to retry if needed
      setTimeout(async () => {
        try {
          const retryResponse = await fetch(followupUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
          });
          if (retryResponse.ok) {
            console.log(`[discord] Successfully sent callback result on retry`);
          }
        } catch (retryError) {
          console.error("[discord] Retry also failed:", retryError);
        }
      }, 100);
    }

    // Return success
    return Response.json({ success: true });
  } catch (error: any) {
    console.error("[discord] Error handling callback:", error);
    return Response.json(
      { error: "Internal server error", message: error?.message },
      { status: 500 }
    );
  }
}

async function handleTelegramCallback(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { telegram_token, result } = body;

    if (!telegram_token) {
      return Response.json({ error: "Missing telegram_token" }, { status: 400 });
    }

    const decodedToken = decodeURIComponent(telegram_token);
    const callbackData = pendingTelegramCallbacks.get(decodedToken);
    if (!callbackData) {
      console.error(`[telegram-callback] Token not found or expired: ${decodedToken.substring(0, 30)}...`);
      return Response.json({ error: "Invalid or expired callback token" }, { status: 404 });
    }

    // Remove from pending immediately
    pendingTelegramCallbacks.delete(decodedToken);

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      console.error("[telegram] TELEGRAM_BOT_TOKEN not set");
      return Response.json({ error: "Telegram bot token missing" }, { status: 500 });
    }

    const output = result?.output || result;
    
    // Determine if this is a search_events callback or summarise callback
    const isSearchCallback = callbackData.topic !== undefined;
    
    let messageText: string;
    
    if (isSearchCallback) {
      // For search_events: use formattedMessage directly
      messageText = (output?.formattedMessage || output?.text || "").trim();
      
      if (!messageText) {
        messageText = "No events found. Please try a different search query.";
      }

      // Store search state for pagination
      if (output?.events && Array.isArray(output.events)) {
        const { searchState } = await import("./pending");
        // Store all events (not just the current page) for pagination
        const allEvents = (output.allEvents || output.events) as Array<{
          id: string;
          title: string;
          url: string;
          description?: string;
          location?: string;
          date?: string;
          attendeeCount?: number;
        }>;
        
        if (allEvents.length > 0) {
          searchState.set(callbackData.chatId, {
            events: allEvents,
            topic: callbackData.topic!,
            location: callbackData.location,
            offset: 0, // Start at 0, will be updated when /more is called
            expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour
          });
        }
      }
    } else {
      // For summarise: process summary with cleaning
      let summary = (output?.summary || output?.text || "").trim();
      
      // Debug logging
      console.log(`[telegram-callback] Raw result keys:`, Object.keys(result || {}));
      console.log(`[telegram-callback] Raw output keys:`, Object.keys(output || {}));
      console.log(`[telegram-callback] Raw summary length: ${summary.length}`);
      console.log(`[telegram-callback] Summary preview: ${summary.substring(0, 200)}`);
      
      // Fix greeting if it appears as a bullet point - remove bullet and place on new line
      summary = summary.replace(/^•\s*(Good (morning|afternoon|evening)![^\n]*)/m, "$1");
      
      // Remove any duplicate greeting lines (keep only the first one)
      const greetingPattern = /^(Good (morning|afternoon|evening)![^\n]*)/m;
      let firstGreetingIndex = -1;
      summary = summary.replace(new RegExp(greetingPattern.source, "gm"), (match: string, offset: number) => {
        if (firstGreetingIndex === -1) {
          // Keep the first greeting
          firstGreetingIndex = offset;
          return match;
        } else {
          // Remove subsequent duplicates
          return "";
        }
      }).replace(/\n\n+/g, "\n\n").trim(); // Clean up extra blank lines
      
      // Remove "Hello!" style greetings (should use time-based greetings)
      summary = summary.replace(/^Hello!\s*Here is what happened[^\n]*\n?/im, "");
      
      // Remove payment-related prefixes that might have been included in the summary
      summary = summary
        .replace(/^✅\s*Payment (Confirmed|Required)\s*\n?\n?/gim, "") // Remove "✅ Payment Confirmed" or "✅ Payment Required" at start
        .replace(/💳\s*\*\*Payment Required\*\*[\s\S]*?automatically\./gi, "")
        .replace(/🔗\s*\*\*Pay.*?\n/gi, "")
        .replace(/https?:\/\/[^\s]*pay[^\s]*/gi, "")
        .replace(/To summarise this channel, please pay.*?via x402\./gi, "")
        .trim();
      
      console.log(`[telegram-callback] Summary after cleaning length: ${summary.length}`);
      
      if (!summary) {
        console.warn(`[telegram-callback] Summary was empty after cleaning, using fallback message`);
        summary = "No material updates or chatter in this window.";
      }

      messageText = summary.trim();
    }

    // Send to Telegram - try to complete it quickly, but don't block forever
    try {
      await Promise.race([
        (async () => {
          const sendUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
          // Use Markdown parse mode for search results (contains links) or summaries
          const isSearchCallback = callbackData.topic !== undefined;
          const sendBody: any = {
            chat_id: callbackData.chatId,
            text: messageText,
          };
          if (isSearchCallback || messageText.includes("[")) {
            sendBody.parse_mode = "Markdown";
          }
          const sendResponse = await fetch(sendUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(sendBody),
          });

          if (!sendResponse.ok) {
            const errorText = await sendResponse.text();
            console.error(`[telegram] Failed to send message: ${sendResponse.status} ${errorText}`);
            return;
          }

          if (callbackData.paymentMessageId) {
            const deleteUrl = `https://api.telegram.org/bot${botToken}/deleteMessage`;
            const deleteResponse = await fetch(deleteUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: callbackData.chatId,
                message_id: callbackData.paymentMessageId,
              }),
            });

            if (!deleteResponse.ok) {
              const deleteError = await deleteResponse.text();
              console.warn(`[telegram] Failed to delete payment message: ${deleteResponse.status} ${deleteError}`);
            }
          }

          console.log(`[telegram] Successfully sent callback result to chat ${callbackData.chatId}`);
        })(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Telegram API timeout")), 5000)
        )
      ]);
    } catch (error: any) {
      // If timeout or error, log it but still return success
      console.error("[telegram] Error or timeout posting to Telegram:", error);
      // Fire off a background task to retry if needed
      setTimeout(async () => {
        try {
          const isSearchCallback = callbackData.topic !== undefined;
          const retryBody: any = {
            chat_id: callbackData.chatId,
            text: messageText,
          };
          if (isSearchCallback || messageText.includes("[")) {
            retryBody.parse_mode = "Markdown";
          }
          const retryResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(retryBody),
          });
          if (retryResponse.ok) {
            console.log(`[telegram] Successfully sent callback result on retry`);
          }
        } catch (retryError) {
          console.error("[telegram] Retry also failed:", retryError);
        }
      }, 100);
    }

    // Return success
    return Response.json({ success: true });
  } catch (error: any) {
    console.error("[telegram] Error handling callback:", error);
    return Response.json(
      { error: "Internal server error", message: error?.message },
      { status: 500 }
    );
  }
}

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    // Health checks
    if (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/healthz") {
      return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    // Discord interactions endpoint
    if (url.pathname === "/interactions") {
      if (req.method === "POST") {
        return handleDiscordInteraction(req);
      }
      // Allow GET for testing
      if (req.method === "GET") {
        return Response.json({ 
          status: "ok", 
          message: "Discord interactions endpoint is active",
          publicKey: PUBLIC_KEY ? "set" : "not set"
        });
      }
    }

    // Discord payment callback endpoint
    if (url.pathname === "/discord-callback" && req.method === "POST") {
      return handleDiscordCallback(req);
    }

    if (url.pathname === "/telegram-callback" && req.method === "POST") {
      return handleTelegramCallback(req);
    }

    // Handle searcher.png (logo) with or without query parameters (for cache-busting)
    // Also handle logo.png for backwards compatibility
    if ((url.pathname === "/assets/searcher.png" || url.pathname === "/assets/logo.png") && req.method === "GET") {
      try {
        // Try multiple possible paths - prioritize searcher.png, then logo.png
        const possiblePaths = [
          `${import.meta.dir}/assets/searcher.png`, // src/assets/searcher.png (relative to src/index.ts)
          "./src/assets/searcher.png",
          "src/assets/searcher.png",
          "./public/assets/searcher.png",
          "public/assets/searcher.png",
          `${process.cwd()}/src/assets/searcher.png`,
          `${process.cwd()}/public/assets/searcher.png`,
          // Fallback to logo.png for backwards compatibility
          `${import.meta.dir}/assets/logo.png`,
          "./src/assets/logo.png",
          "src/assets/logo.png",
          "./public/assets/logo.png",
          "public/assets/logo.png",
          `${process.cwd()}/src/assets/logo.png`,
          `${process.cwd()}/public/assets/logo.png`,
        ];
        
        for (const logoPath of possiblePaths) {
          const file = Bun.file(logoPath);
          if (await file.exists()) {
            console.log(`[assets] Serving logo from: ${logoPath}`);
            return new Response(file, {
              headers: {
                "Content-Type": "image/png",
                "Cache-Control": "public, max-age=86400", // Cache for 24 hours
              },
            });
          }
        }
        console.error("[assets] Logo not found in any of the expected paths");
      } catch (error) {
        console.error("[assets] Error serving logo:", error);
      }
      return new Response("Logo not found", { status: 404 });
    }

    // Handle hyperlink.png
    if (url.pathname === "/assets/hyperlink.png" && req.method === "GET") {
      try {
        const possiblePaths = [
          `${import.meta.dir}/assets/hyperlink.png`,
          "./src/assets/hyperlink.png",
          "src/assets/hyperlink.png",
          "./public/assets/hyperlink.png",
          "public/assets/hyperlink.png",
          `${process.cwd()}/src/assets/hyperlink.png`,
          `${process.cwd()}/public/assets/hyperlink.png`,
        ];
        
        for (const imagePath of possiblePaths) {
          const file = Bun.file(imagePath);
          if (await file.exists()) {
            console.log(`[assets] Serving hyperlink.png from: ${imagePath}`);
            return new Response(file, {
              headers: {
                "Content-Type": "image/png",
                "Cache-Control": "public, max-age=86400",
              },
            });
          }
        }
      } catch (error) {
        console.error("[assets] Error serving hyperlink.png:", error);
      }
      return new Response("Image not found", { status: 404 });
    }

    if (url.pathname === "/assets/x402-card.svg" && req.method === "GET") {
      const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="50%" stop-color="#1e3a8a"/>
      <stop offset="100%" stop-color="#0b1120"/>
    </linearGradient>
    <radialGradient id="glow" cx="30%" cy="20%" r="70%">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="logoGradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#61f0ff"/>
      <stop offset="100%" stop-color="#2563eb"/>
    </linearGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="30" stdDeviation="40" flood-color="#0b1120" flood-opacity="0.6"/>
    </filter>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow)" opacity="0.45"/>
  <g transform="translate(180 140)" filter="url(#shadow)">
    <path d="M154 0c90 0 164 75 164 168v40c0 93-74 168-164 168-23 0-44-4-64-12l-78 62c-12 9-28-5-20-18l41-69c-28-29-43-67-43-111v-60C-74 75 0 0 90 0h64z" fill="url(#logoGradient)"/>
    <rect x="66" y="108" width="176" height="116" rx="58" fill="#0f172a"/>
    <circle cx="116" cy="166" r="32" fill="#8be3ff"/>
    <circle cx="192" cy="166" r="32" fill="#8be3ff"/>
    <g fill="#7ff8ff">
      <circle cx="88" cy="36" r="22"/>
      <circle cx="220" cy="36" r="22"/>
      <rect x="150" y="10" width="8" height="52" rx="4"/>
      <rect x="150" y="10" width="8" height="52" rx="4" transform="rotate(12 154 36)"/>
    </g>
  </g>
  <g transform="translate(420 215)">
    <text x="0" y="0" font-family="'Inter', 'Segoe UI', system-ui, sans-serif" font-size="72" font-weight="700" fill="#f8fafc">x402 Summariser Bot</text>
    <text x="0" y="96" font-family="'Inter', 'Segoe UI', system-ui, sans-serif" font-size="34" fill="rgba(226,232,240,0.88)">Summarise your Discord &amp; Telegram chats for $0.05 via x402.</text>
  </g>
</svg>`;
      return new Response(svg, {
        headers: {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    // Payment page - handles GET requests and shows payment UI
    if (url.pathname === "/pay" && req.method === "GET") {
      const source = url.searchParams.get("source") ?? "discord";
      const channelId = url.searchParams.get("channelId");
      const chatId = url.searchParams.get("chatId");
      const serverId = url.searchParams.get("serverId");
      const lookbackMinutesParam = url.searchParams.get("lookbackMinutes");
      const topic = url.searchParams.get("topic");
      const location = url.searchParams.get("location");
      const discordCallback = url.searchParams.get("discord_callback");
      const telegramCallback = url.searchParams.get("telegram_callback");

      const usingTelegram = source === "telegram";
      const primaryId = usingTelegram ? chatId : channelId;
      
      // Determine if this is a search_events request or summarise request
      const isSearchRequest = topic !== null;

      // Validate required parameters based on request type
      if (!primaryId) {
        return Response.json({ error: "Missing required parameters (chatId/channelId)" }, { status: 400 });
      }
      
      if (!isSearchRequest && !lookbackMinutesParam) {
        return Response.json({ error: "Missing required parameters (lookbackMinutes for summarise)" }, { status: 400 });
      }
      
      if (isSearchRequest && !topic) {
        return Response.json({ error: "Missing required parameters (topic for search)" }, { status: 400 });
      }

      let lookbackMinutes: number | undefined;
      if (!isSearchRequest && lookbackMinutesParam) {
        const lookbackValidation = validateLookback(lookbackMinutesParam);
        if ("error" in lookbackValidation) {
          return Response.json({ error: lookbackValidation.error }, { status: 400 });
        }
        lookbackMinutes = lookbackValidation.minutes;
      }

      const agentBaseUrl =
        process.env.AGENT_URL || `https://x402-summariser-production.up.railway.app`;
      
      let entrypointPath: string;
      let heading: string;
      let entityLabel: string;
      let postPaymentPrompt: string;
      
      if (isSearchRequest) {
        entrypointPath = "search%20luma%20events";
        heading = "🪙 Search Luma Events";
        entityLabel = location ? "Topic & Location" : "Topic";
        postPaymentPrompt = "After payment, your event search results will automatically appear in Telegram.";
      } else {
        entrypointPath = usingTelegram
          ? "summarise%20telegram%20chat"
          : "summarise%20chat";
        heading = usingTelegram
          ? "🪙 Summarise Telegram Chat"
          : "🪙 Summarise Discord Channel";
        entityLabel = usingTelegram ? "Chat ID" : "Channel ID";
        postPaymentPrompt = usingTelegram
          ? "After payment, your summary will automatically appear in Telegram."
          : "After payment, your summary will automatically appear in Discord.";
      }
      
      const entrypointUrl = `${agentBaseUrl}/entrypoints/${entrypointPath}/invoke`;
      const price = process.env.ENTRYPOINT_PRICE || "0.05";
      const currency = process.env.PAYMENT_CURRENCY || "USDC";

      // Ensure HTTPS origin
      const origin = url.origin.replace(/^http:/, "https:");
      const logoUrl = `${origin}/assets/searcher.png`;

      const pageConfig = {
        source,
        channelId,
        chatId,
        serverId,
        lookbackMinutes,
        topic,
        location,
        entrypointUrl,
        discordCallback,
        telegramCallback,
      };

      return new Response(`<!DOCTYPE html>
<html>
<head>
  <title>${heading.replace(/<[^>]+>/g, "")}</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { 
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; 
      max-width: 600px; 
      margin: 50px auto; 
      padding: 20px;
      background: linear-gradient(135deg, #000000 0%, #1a0033 25%, #4b0082 50%, #8b00ff 75%, #ff1493 100%) fixed;
      color: #e2e8f0;
      min-height: 100vh;
    }
    .container { 
      background: linear-gradient(145deg, rgba(0, 0, 0, 0.85), rgba(26, 0, 51, 0.9));
      border: 1px solid rgba(255, 20, 147, 0.3);
      padding: 30px; 
      border-radius: 16px;
      box-shadow: 0 24px 48px rgba(139, 0, 255, 0.4), 0 0 60px rgba(255, 20, 147, 0.2);
      backdrop-filter: blur(14px);
    }
    .logo {
      width: 120px;
      height: 120px;
      margin: 0 auto 20px;
      background-image: url("${logoUrl}");
      background-size: contain;
      background-position: center;
      background-repeat: no-repeat;
      filter: drop-shadow(0 0 20px rgba(255, 20, 147, 0.5));
    }
    h1 { 
      color: #ffffff; 
      margin-top: 0;
      text-align: center;
      font-size: 1.75rem;
      text-shadow: 0 0 10px rgba(255, 20, 147, 0.5);
    }
    .info { 
      background: linear-gradient(160deg, rgba(75, 0, 130, 0.4), rgba(26, 0, 51, 0.6));
      border: 1px solid rgba(255, 20, 147, 0.25);
      padding: 15px; 
      border-radius: 8px; 
      margin: 20px 0;
      color: #f0e6ff;
    }
    .button { 
      background: linear-gradient(120deg, #ff1493, #8b00ff);
      color: #ffffff;
      padding: 12px 24px; 
      border: none; 
      border-radius: 6px; 
      cursor: pointer; 
      font-size: 16px; 
      margin-top: 20px;
      width: 100%;
      font-weight: 600;
      box-shadow: 0 12px 32px rgba(255, 20, 147, 0.5), 0 0 20px rgba(139, 0, 255, 0.3);
      transition: all 0.3s ease;
    }
    .button:hover { 
      background: linear-gradient(120deg, #ff69b4, #9d4edd);
      box-shadow: 0 18px 40px rgba(255, 20, 147, 0.6), 0 0 30px rgba(139, 0, 255, 0.4);
      transform: translateY(-2px);
    }
    #status {
      color: #f0e6ff;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo"></div>
    <h1>${heading}</h1>
    <div class="info">
      <p><strong>Price:</strong> $${price} ${currency}</p>
      ${isSearchRequest 
        ? `<p><strong>Topic:</strong> ${topic}</p>${location ? `<p><strong>Location:</strong> ${location}</p>` : ''}`
        : `<p><strong>${entityLabel}:</strong> ${primaryId}</p><p><strong>Lookback:</strong> ${lookbackMinutes} minutes</p>`
      }
    </div>
    <p style="text-align: center; color: #cbd5f5;">Click below to pay via x402. ${postPaymentPrompt}</p>
    <button class="button" onclick="pay()">Pay $${price} ${currency}</button>
    <div id="status" style="margin-top: 20px;"></div>
  </div>
  <script type="importmap">
    {
      "imports": {
        "x402-fetch": "https://esm.sh/x402-fetch@0.7.0?bundle",
        "x402/types": "https://esm.sh/x402@0.7.0/types?bundle",
        "x402/client": "https://esm.sh/x402@0.7.0/client?bundle",
        "x402/shared": "https://esm.sh/x402@0.7.0/shared?bundle",
        "viem": "https://esm.sh/viem@2.21.26?bundle",
        "viem/chains": "https://esm.sh/viem@2.21.26/chains?bundle"
      }
    }
  </script>
  <script type="module">
    const PAGE_CONFIG = ${JSON.stringify(pageConfig)};
    PAGE_CONFIG.price = '${price}';
    PAGE_CONFIG.currency = '${currency}';

    let wrapFetchWithPayment;
    let createWalletClient;
    let custom;
    let base;
    let moduleLoaded = false;
    
    // Load x402-fetch and viem using import map (esm.sh with bundle flag handles dependencies)
    (async () => {
      try {
        const [x402Module, viemModule, chainsModule] = await Promise.all([
          import('x402-fetch'),
          import('viem'),
          import('viem/chains')
        ]);
        wrapFetchWithPayment = x402Module.wrapFetchWithPayment;
        createWalletClient = viemModule.createWalletClient;
        custom = viemModule.custom;
        base = chainsModule.base;
        
        if (wrapFetchWithPayment && createWalletClient && custom && base) {
          console.log('✅ x402-fetch and viem loaded successfully');
          moduleLoaded = true;
        } else {
          console.error('❌ Missing exports. wrapFetchWithPayment:', !!wrapFetchWithPayment, 'createWalletClient:', !!createWalletClient, 'custom:', !!custom, 'base:', !!base);
        }
      } catch (importError) {
        console.error('❌ Failed to import modules:', importError);
        console.error('Error details:', importError.message);
      }
    })();
    
    async function pay() {
      const cfg = PAGE_CONFIG;
      const status = document.getElementById('status');
      
      // Wait a bit for module to load if it hasn't yet
      if (!moduleLoaded && !wrapFetchWithPayment) {
        status.innerHTML = '<p>⏳ Loading payment library...</p>';
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      if (!wrapFetchWithPayment || !createWalletClient || !custom || !base) {
        status.innerHTML = '<p style="color: red;">⚠️ Error: Could not load payment libraries.</p><p style="font-size: 12px; color: #666;">Please refresh the page and try again.</p>';
        console.error('❌ Required modules not available. wrapFetchWithPayment:', !!wrapFetchWithPayment, 'createWalletClient:', !!createWalletClient);
        return;
      }
      
      status.innerHTML = '<p>🔌 Connecting wallet...</p>';
      
      try {
        // Check if window.ethereum (MetaMask) or other wallet is available
        if (typeof window.ethereum === 'undefined' && typeof window.x402 === 'undefined') {
          throw new Error('No wallet found. Please install MetaMask or an x402-compatible wallet extension.');
        }
        
        // Get wallet provider
        const walletProvider = window.ethereum || window.x402;
        
        // Request wallet connection (required for MetaMask)
        let accountAddress;
        if (walletProvider.request) {
          try {
            const accounts = await walletProvider.request({ method: 'eth_requestAccounts' });
            console.log('✅ Wallet connected');
            
            if (!accounts || accounts.length === 0) {
              throw new Error('No accounts found. Please unlock your wallet.');
            }
            
            accountAddress = accounts[0];
            
            // Ensure we're on Base network (required for payment)
            status.innerHTML = '<p>🔗 Checking network...</p>';
            const BASE_CHAIN_ID = 8453;
            const BASE_CHAIN_ID_HEX = '0x' + BASE_CHAIN_ID.toString(16);
            
            try {
              const currentChainIdHex = await walletProvider.request({ method: 'eth_chainId' });
              const currentChainId = parseInt(currentChainIdHex, 16);
              
              if (currentChainId !== BASE_CHAIN_ID) {
                status.innerHTML = '<p>⚠️ Switching to Base network...</p>';
                console.warn('⚠️ Wrong network. Current:', currentChainId, 'Required:', BASE_CHAIN_ID);
                
                try {
                  // Try to switch to Base network
                  await walletProvider.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{ chainId: BASE_CHAIN_ID_HEX }],
                  });
                  status.innerHTML = '<p>✅ Switched to Base network</p>';
                } catch (switchError) {
                  // If the error is 4902, the chain is not added to MetaMask
                  if (switchError.code === 4902) {
                    console.warn('⚠️ Base network not found in wallet. Adding...');
                    status.innerHTML = '<p>➕ Adding Base network to wallet...</p>';
                    
                    await walletProvider.request({
                      method: 'wallet_addEthereumChain',
                      params: [{
                        chainId: BASE_CHAIN_ID_HEX,
                        chainName: 'Base',
                        nativeCurrency: {
                          name: 'Ethereum',
                          symbol: 'ETH',
                          decimals: 18
                        },
                        rpcUrls: ['https://mainnet.base.org'],
                        blockExplorerUrls: ['https://basescan.org']
                      }],
                    });
                  } else if (switchError.code === 4001) {
                    throw new Error('Network switch rejected. Please switch to Base network manually in MetaMask.');
                  } else {
                    throw new Error('Failed to switch network. Please switch to Base network manually in MetaMask.');
                  }
                }
              } else {
                status.innerHTML = '<p>✅ Already on Base network</p>';
              }
            } catch (networkError) {
              console.error('❌ Network check error:', networkError);
              throw new Error('Network error: ' + (networkError.message || 'Please ensure you are on Base network'));
            }
          } catch (connError) {
            if (connError.code === 4001) {
              throw new Error('Wallet connection rejected. Please approve the connection to continue.');
            }
            throw connError;
          }
        }
        
        // Create a viem wallet client (x402-fetch expects this format)
        const walletClient = createWalletClient({
          account: accountAddress,
          chain: base,
          transport: custom(walletProvider)
        });
        
        // Wrap fetch with payment handling (pass viem wallet client)
        // maxValue: 0.05 USDC = 50000 (6 decimals)
        // Note: x402 uses EIP-3009 for gasless transactions - facilitator pays gas
        const x402Fetch = wrapFetchWithPayment(fetch, walletClient, BigInt(50000));
        
        const entrypointUrl = cfg.entrypointUrl;
        
        status.innerHTML = '<p>🪙 Processing payment (gasless via facilitator)...</p>';
        
        // Determine request type and build input accordingly
        const isSearchRequest = cfg.topic;
        let requestInput;
        
        if (isSearchRequest) {
          // Search events request
          requestInput = {
            topic: cfg.topic,
            location: cfg.location || undefined,
            limit: 10
          };
        } else if (cfg.source === 'telegram') {
          // Summarise telegram request
          requestInput = {
            chatId: cfg.chatId,
            lookbackMinutes: cfg.lookbackMinutes,
            source: 'telegram'
          };
        } else {
          // Summarise discord request
          requestInput = {
            channelId: cfg.channelId,
            serverId: cfg.serverId || undefined,
            lookbackMinutes: cfg.lookbackMinutes
          };
        }

        console.log('📋 Request details:', {
          url: entrypointUrl,
          method: 'POST',
          input: requestInput,
        });
        
        // Check USDC balance before payment to verify transaction processing
        const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base
        let balanceBefore = null;
        try {
          // ERC-20 balanceOf(address) - function selector: 0x70a08231
          const balanceData = await walletProvider.request({
            method: 'eth_call',
            params: [{
              to: USDC_ADDRESS,
              data: '0x70a08231' + accountAddress.slice(2).padStart(64, '0')
            }, 'latest']
          });
          balanceBefore = BigInt(balanceData);
        } catch (balanceError) {
          console.warn('⚠️ Could not check USDC balance:', balanceError);
        }
        
        // Log before the request to track when MetaMask should prompt
        console.log('⏳ Calling x402Fetch - MetaMask should prompt for EIP-3009 signature (not a transaction)...');
        console.log('📝 Note: x402 uses EIP-3009 permits - you are signing a message, not sending a transaction.');
        console.log('📝 The facilitator will process the permit and create a transaction.');
        
        let response;
        try {
          response = await x402Fetch(entrypointUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              input: requestInput,
            }),
          });
          
          // Check USDC balance after payment to verify transaction processed
          if (balanceBefore !== null) {
            try {
              await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s for transaction to process
              const balanceDataAfter = await walletProvider.request({
                method: 'eth_call',
                params: [{
                  to: USDC_ADDRESS,
                  data: '0x70a08231' + accountAddress.slice(2).padStart(64, '0')
                }, 'latest']
              });
              const balanceAfter = BigInt(balanceDataAfter);
            } catch (balanceError) {
              console.warn('⚠️ Could not check USDC balance after payment:', balanceError);
            }
          }
        } catch (paymentError) {
          console.error('❌ Payment processing error:', paymentError);
          console.error('❌ Payment error details:', {
            message: paymentError.message,
            stack: paymentError.stack,
            name: paymentError.name,
            code: paymentError.code,
            data: paymentError.data
          });
          throw new Error('Payment failed: ' + (paymentError.message || 'Unknown error. Please check the console for details.'));
        }

        // Check response status first
        if (!response.ok) {
          const errorText = await response.text();
          console.error('❌ Response not OK:', response.status, response.statusText);
          console.error('❌ Error response:', errorText.substring(0, 500));
          throw new Error('Server returned ' + response.status + ' ' + response.statusText + ': ' + errorText.substring(0, 200));
        }
        
        // Check for transaction hash in X-PAYMENT-RESPONSE header
        const paymentResponseHeader = response.headers.get('X-PAYMENT-RESPONSE');
        
        // Check content type before parsing JSON
        const contentType = response.headers.get('content-type') || '';
        let data;
        
        // Clone response so we can read it multiple times if needed
        const responseClone = response.clone();
        
        if (!contentType.includes('application/json')) {
          // If not JSON, try to get text first to see what we got
          const text = await responseClone.text();
          console.error('❌ Expected JSON but got:', contentType);
          console.error('❌ Response preview:', text.substring(0, 500));
          throw new Error('Server returned ' + contentType + ' instead of JSON. Response: ' + text.substring(0, 200));
        }
        
        try {
          data = await response.json();
        } catch (jsonError) {
          // If JSON parsing fails, try to get the raw text to debug
          const text = await responseClone.text();
          console.error('❌ Failed to parse JSON response:', jsonError);
          console.error('❌ Response status:', response.status);
          console.error('❌ Response headers:', Object.fromEntries(response.headers.entries()));
          console.error('❌ Response text:', text.substring(0, 1000));
          throw new Error('Invalid JSON response: ' + jsonError.message + '. Response preview: ' + text.substring(0, 200));
        }
        
        // Extract transaction hash from various possible locations
        let txHash = null;
        let explorerUrl = null;
        
        if (paymentResponseHeader) {
          try {
            const decodedHeader = window.atob(paymentResponseHeader);
            const paymentInfo = JSON.parse(decodedHeader);
            txHash = paymentInfo.txHash || paymentInfo.transactionHash || paymentInfo.hash;
          } catch (e) {
            console.warn('⚠️ Could not parse X-PAYMENT-RESPONSE header:', e);
          }
        }
        
        // Check in response data recursively
        if (!txHash && data.payment) {
          txHash = data.payment.txHash || data.payment.transactionHash || data.payment.hash;
        }
        
        if (!txHash && data.txHash) {
          txHash = data.txHash;
        }
        
        if (!txHash && data.transactionHash) {
          txHash = data.transactionHash;
        }
        
        // Check in nested locations (x402 might store it differently)
        if (!txHash && data.metadata && data.metadata.payment) {
          txHash = data.metadata.payment.txHash || data.metadata.payment.transactionHash || data.metadata.payment.hash;
        }
        
        if (!txHash && data.context && data.context.payment) {
          const paymentCtx = data.context.payment;
          txHash = paymentCtx.txHash || paymentCtx.transactionHash || paymentCtx.hash;
        }
        
        // Check for any field containing "tx" or "hash"
        if (!txHash) {
          for (const key in data) {
            if (key.toLowerCase().includes('tx') || key.toLowerCase().includes('hash')) {
              const value = data[key];
              if (typeof value === 'string' && value.startsWith('0x')) {
                txHash = value;
                break;
              }
            }
          }
        }
        
        const successMarkup = (hash) => {
          const destination = cfg.source === 'telegram' ? 'Telegram' : 'Discord';
          if (!hash) {
            return '<div style="color: #117a39;">' +
              '<p style="font-size: 20px; margin: 0 0 8px;">✅ Payment complete!</p>' +
              '<p style="font-size: 13px; color: #1f5132; margin: 0;">Check ' + destination + ' for your summary.</p>' +
              '</div>';
          }

          const explorer = 'https://basescan.org/tx/' + hash;
          return '<div style="color: #117a39;">' +
            '<p style="font-size: 20px; margin: 0 0 8px;">✅ Payment complete!</p>' +
            '<p style="margin: 0 0 12px;">View on BaseScan: <a href="' + explorer + '" target="_blank" rel="noopener" style="color: #0b5e27;">' + hash + '</a></p>' +
            '<p style="font-size: 13px; color: #1f5132; margin: 0;">Check ' + destination + ' for your summary.</p>' +
            '</div>';
        };

        if (txHash) {
          console.log('✅ Transaction hash found:', txHash);
          status.innerHTML = successMarkup(txHash);
        } else {
          status.innerHTML = successMarkup(null);
        }
        
        if (response.ok) {
          if (cfg.discordCallback) {
            fetch('/discord-callback', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                discord_token: cfg.discordCallback,
                result: data,
              }),
            }).catch(function(err) {
              console.error('❌ Callback error:', err);
              status.innerHTML += '<p style="color: orange;">⚠️ Payment successful but failed to send to Discord. Please contact support.</p>';
            });
          }

          if (cfg.telegramCallback) {
            fetch('/telegram-callback', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                telegram_token: cfg.telegramCallback,
                result: data,
              }),
            }).catch(function(err) {
              console.error('❌ Telegram callback error:', err);
              status.innerHTML += '<p style="color: orange;">⚠️ Payment successful but failed to send to Telegram. Please contact support.</p>';
            });
          }
        } else if (response.status === 402) {
          status.innerHTML = '<p style="color: orange;">💳 Payment required. Please connect your x402 wallet and approve the transaction.</p>';
        } else {
          const errorMsg = data.error ? (data.error.message || JSON.stringify(data)) : JSON.stringify(data);
          status.innerHTML = '<p style="color: red;">❌ Error: ' + errorMsg + '</p>';
        }
      } catch (error) {
        console.error('❌ Payment error:', error);
        status.innerHTML = '<p style="color: red;">❌ Error: ' + error.message + '</p>';
        if (error.message.includes('wallet') || error.message.includes('user rejected') || error.message.includes('User rejected')) {
          status.innerHTML += '<p style="font-size: 12px; color: #666;">Make sure you have an x402 wallet browser extension installed and approved the transaction.</p>';
        } else if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
          status.innerHTML += '<p style="font-size: 12px; color: #666;">Network error. Please check your connection and try again.</p>';
        } else {
          status.innerHTML += '<p style="font-size: 12px; color: #666;">Check browser console (F12) for more details.</p>';
        }
      }
    }
    
    window.pay = pay;
  </script>
</body>
</html>`, {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Hyperlink page - displays hyperlink.png as clickable link to download page
    if (url.pathname === "/link" && req.method === "GET") {
      const origin = url.origin.replace(/^http:/, "https:");
      const imageUrl = `${origin}/assets/hyperlink.png`;
      const downloadUrl = `${origin}/download`;
      
      return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Luma Event Search Bot</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      background: linear-gradient(135deg, #000000 0%, #1a0033 25%, #4b0082 50%, #8b00ff 75%, #ff1493 100%) fixed;
      padding: 20px;
    }
    a {
      display: inline-block;
      transition: transform 0.2s ease, opacity 0.2s ease;
    }
    a:hover {
      transform: scale(1.02);
      opacity: 0.9;
    }
    a:active {
      transform: scale(0.98);
    }
    img {
      max-width: 100%;
      height: auto;
      display: block;
    }
  </style>
</head>
<body>
  <a href="${downloadUrl}" target="_blank" rel="noopener">
    <img src="${imageUrl}" alt="Luma Event Search Bot - Click to visit download page">
  </a>
</body>
</html>`, {
        headers: { "Content-Type": "text/html" },
      });
    }

    if (url.pathname === "/download" && req.method === "GET") {
      // Ensure HTTPS origin
      const origin = url.origin.replace(/^http:/, "https:");
      const ogImageUrl = `${origin}/assets/hyperlink.png`;
      const telegramBotUsername = process.env.TELEGRAM_BOT_USERNAME || "LumaEventSearchBot";
      return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Luma Event Search Bot</title>
  <meta name="description" content="Search for events on Luma.com by topic and location. Get up to 5 events sorted by popularity for $0.05 via x402.">
  <meta property="og:title" content="Luma Event Search Bot">
  <meta property="og:description" content="Search for events on Luma.com by topic and location. Get up to 5 events sorted by popularity for $0.05 via x402.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${origin}/download">
  <meta property="og:image" content="${ogImageUrl}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Luma Event Search Bot">
  <meta name="twitter:description" content="Search for events on Luma.com by topic and location. Get up to 5 events sorted by popularity for $0.05 via x402.">
  <meta name="twitter:image" content="${ogImageUrl}">
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(135deg, #000000 0%, #1a0033 25%, #4b0082 50%, #8b00ff 75%, #ff1493 100%) fixed;
      color: #e2e8f0;
      display: flex;
      justify-content: center;
      padding: 48px 16px 96px;
      min-height: 100vh;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      background: radial-gradient(circle at 20% 20%, rgba(255, 20, 147, 0.2), transparent 55%),
                  radial-gradient(circle at 80% 10%, rgba(139, 0, 255, 0.15), transparent 50%),
                  radial-gradient(circle at 40% 80%, rgba(75, 0, 130, 0.2), transparent 55%);
      pointer-events: none;
      z-index: -2;
    }
    body::after {
      content: "";
      position: fixed;
      inset: 0;
      background: linear-gradient(180deg, rgba(0, 0, 0, 0.8), rgba(26, 0, 51, 0.95));
      z-index: -1;
    }
    .page {
      width: min(840px, 100%);
      position: relative;
    }
    .page::before {
      content: "";
      position: absolute;
      inset: -40px;
      background: radial-gradient(circle at 0% 0%, rgba(255, 20, 147, 0.4), transparent 55%);
      filter: blur(120px);
      z-index: -1;
    }
    header {
      margin-bottom: 48px;
      text-align: center;
    }
    h1 {
      margin: 0 0 16px;
      font-size: clamp(2rem, 6vw, 3.2rem);
      letter-spacing: -0.03em;
      color: #ffffff;
      text-shadow: 0 0 20px rgba(255, 20, 147, 0.5);
    }
    p.lead {
      margin: 0 auto;
      max-width: 620px;
      font-size: 1.1rem;
      line-height: 1.6;
      color: #f0e6ff;
    }
    .logo {
      width: 120px;
      height: 120px;
      margin: 0 auto 24px;
      display: block;
      filter: drop-shadow(0 0 20px rgba(255, 20, 147, 0.5));
    }
    .logo img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    section {
      background: linear-gradient(145deg, rgba(0, 0, 0, 0.85), rgba(26, 0, 51, 0.9));
      border: 1px solid rgba(255, 20, 147, 0.3);
      border-radius: 16px;
      padding: 32px;
      margin-bottom: 32px;
      backdrop-filter: blur(14px);
      box-shadow: 0 24px 48px rgba(139, 0, 255, 0.4), 0 0 60px rgba(255, 20, 147, 0.2);
    }
    section h2 {
      margin-top: 0;
      font-size: 1.5rem;
      color: #ff69b4;
    }
    .steps {
      counter-reset: step;
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      gap: 16px;
    }
    .steps li {
      padding: 20px 24px;
      border-radius: 12px;
      background: linear-gradient(160deg, rgba(75, 0, 130, 0.4), rgba(26, 0, 51, 0.6));
      border: 1px solid rgba(255, 20, 147, 0.25);
      position: relative;
      line-height: 1.5;
      color: #f0e6ff;
    }
    .steps li::before {
      counter-increment: step;
      content: counter(step);
      position: absolute;
      left: -14px;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      font-weight: 600;
      background: linear-gradient(120deg, #ff1493, #8b00ff);
      color: #ffffff;
      box-shadow: 0 8px 18px rgba(255, 20, 147, 0.5);
    }
    .actions {
      display: grid;
      gap: 20px;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    }
    .action-card {
      padding: 28px;
      border-radius: 14px;
      background: linear-gradient(160deg, rgba(26, 0, 51, 0.9), rgba(75, 0, 130, 0.6));
      border: 1px solid rgba(255, 20, 147, 0.3);
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .action-card h3 {
      margin: 0;
      font-size: 1.25rem;
      color: #ff69b4;
    }
    .action-card p {
      margin: 0;
      color: #f0e6ff;
      line-height: 1.5;
    }
    a.button,
    span.button-disabled {
      margin-top: auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 14px 20px;
      border-radius: 999px;
      font-weight: 600;
      text-decoration: none;
      transition: transform 0.18s ease, box-shadow 0.18s ease;
    }
    a.button {
      background: linear-gradient(120deg, #ff1493, #8b00ff);
      color: #ffffff;
      box-shadow: 0 12px 32px rgba(255, 20, 147, 0.5), 0 0 20px rgba(139, 0, 255, 0.3);
    }
    a.button:hover {
      transform: translateY(-1px);
      box-shadow: 0 18px 40px rgba(255, 20, 147, 0.6), 0 0 30px rgba(139, 0, 255, 0.4);
    }
    span.button-disabled {
      background: rgba(75, 0, 130, 0.3);
      color: rgba(240, 230, 255, 0.6);
      border: 1px dashed rgba(255, 20, 147, 0.35);
      cursor: not-allowed;
    }
    code {
      background: rgba(75, 0, 130, 0.4);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'Monaco', 'Courier New', monospace;
      color: #ff69b4;
      border: 1px solid rgba(255, 20, 147, 0.2);
    }
    footer {
      margin-top: 48px;
      text-align: center;
      font-size: 0.85rem;
      color: rgba(240, 230, 255, 0.6);
    }
  </style>
</head>
<body>
  <main class="page">
    <header>
      <div class="logo">
        <img src="${ogImageUrl}" alt="Luma Event Search Bot Logo">
      </div>
      <h1>Luma Event Search Bot</h1>
      <p class="lead">Search for events on Luma.com by topic and location. Get up to 5 events sorted by popularity, then use <code>/more</code> to see the next batch.</p>
    </header>

    <section>
      <h2>How It Works</h2>
      <ol class="steps">
        <li>Install the bot into your Telegram chat.</li>
        <li>Use <code>/search_events on &lt;topic&gt; in &lt;city&gt;</code> to find events.</li>
        <li>Pay securely via x402 ($0.05), then receive up to 5 events sorted by most attendees right in your chat.</li>
      </ol>
    </section>

    <section>
      <h2>Download</h2>
      <div class="actions">
        <div class="action-card">
          <h3>Telegram Bot</h3>
          <p>Add the bot to your chats and search for events directly inside Telegram.</p>
          <a class="button" href="https://t.me/${telegramBotUsername}" target="_blank" rel="noopener">Open in Telegram</a>
        </div>
      </div>
    </section>

    <footer>Need help or want early access elsewhere? Contact @lordcumberlord on X.</footer>
  </main>
</body>
</html>`, {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Agent app routes - intercept entrypoint responses for Discord callbacks
    if (url.pathname.includes("/entrypoints/") && url.pathname.includes("/invoke")) {
      const isSummariseEndpoint =
        url.pathname.includes("summarise%20chat") ||
        url.pathname.includes("summarise chat") ||
        url.pathname.includes("summarise%20telegram%20chat") ||
        url.pathname.includes("summarise telegram chat");
      const isSearchEndpoint =
        url.pathname.includes("search%20luma%20events") ||
        url.pathname.includes("search luma events");
      
      if (isSummariseEndpoint || isSearchEndpoint) {
        const hasPaymentHeader = req.headers.get("X-PAYMENT");
        console.log(`[payment] Entrypoint called: ${url.pathname}`);

        let sourceLabel: string;
        if (isSearchEndpoint) {
          sourceLabel = "Search Luma events";
        } else if (url.pathname.includes("telegram")) {
          sourceLabel = "Summarise Telegram chat";
        } else {
          sourceLabel = "Summarise Discord channel";
        }

        const payToAddress = (
          process.env.PAY_TO || "0x1b0006dbfbf4d8ec99cd7c40c43566eaa7d95fed"
        ).toLowerCase();
        const facilitatorUrl =
          process.env.FACILITATOR_URL || "https://facilitator.daydreams.systems";
        const agentBaseUrl =
          process.env.AGENT_URL || `https://x402-summariser-production.up.railway.app`;
        // Normalize pathname to remove leading slashes and ensure single slash
        const normalizedPath = url.pathname.replace(/^\/+/, '/');
        const fullEntrypointUrl =
          agentBaseUrl.replace(/\/+$/, '') + normalizedPath + (url.search ? url.search : "");
        const price = process.env.ENTRYPOINT_PRICE || "0.05";
        const currency = process.env.PAYMENT_CURRENCY || "USDC";
        const x402Version = 1.0;

        const paymentRequirement = {
          scheme: "exact" as const,
          resource: fullEntrypointUrl,
          description: `${sourceLabel} - Pay $${price} ${currency}`,
          mimeType: "application/json",
          payTo: payToAddress,
          maxAmountRequired: "50000",
          maxTimeoutSeconds: 300,
          network: "base" as const,
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          extra: {
            name: "USD Coin",
            version: "2",
          },
        };
        const paymentRequirements = [paymentRequirement];

        if (!hasPaymentHeader) {
          console.log(`[payment] Returning 402 Payment Required for: ${fullEntrypointUrl}`);
          return Response.json(
            {
              x402Version,
              accepts: paymentRequirements,
            },
            { status: 402 }
          );
        }

        let decodedPayment;
        try {
          decodedPayment = exact.evm.decodePayment(hasPaymentHeader);
          decodedPayment.x402Version = x402Version;
        } catch (error) {
          console.error("[payment] Failed to decode X-PAYMENT header", error);
          return Response.json(
            {
              error: "Invalid or malformed payment header",
              accepts: paymentRequirements,
              x402Version,
            },
            { status: 402 }
          );
        }

        const selectedPaymentRequirements = findMatchingPaymentRequirements(
          paymentRequirements,
          decodedPayment
        );

        if (!selectedPaymentRequirements) {
          console.error("[payment] Unable to match payment requirements", decodedPayment);
          return Response.json(
            {
              error: "Unable to match payment requirements",
              accepts: paymentRequirements,
              x402Version,
            },
            { status: 402 }
          );
        }

        const facilitatorClient = useFacilitator({
          url: facilitatorUrl as `${string}://${string}`,
        });
        let verification;
        try {
          verification = await facilitatorClient.verify(
            decodedPayment,
            selectedPaymentRequirements
          );
        } catch (error) {
          console.error("[payment] Facilitator verification error", error);
          return Response.json(
            {
              error: "Failed to verify payment",
              accepts: paymentRequirements,
              x402Version,
            },
            { status: 402 }
          );
        }

        if (!verification.isValid) {
          console.error("[payment] Payment verification failed", verification);
          return Response.json(
            {
              error: verification.invalidReason || "Payment verification failed",
              accepts: paymentRequirements,
              payer: verification.payer,
              x402Version,
            },
            { status: 402 }
          );
        }

        const appResponse = await app.fetch(req);

        if (appResponse.status >= 400) {
          return appResponse;
        }

        const appResponseClone = appResponse.clone();
        let settlement;
        let settlementError = false;
        try {
          console.log("[payment] Attempting settlement with:", {
            decodedPaymentKeys: Object.keys(decodedPayment),
            selectedRequirementsKeys: Object.keys(selectedPaymentRequirements),
            resource: selectedPaymentRequirements.resource,
            payTo: selectedPaymentRequirements.payTo,
            maxAmountRequired: selectedPaymentRequirements.maxAmountRequired,
          });
          settlement = await facilitatorClient.settle(
            decodedPayment,
            selectedPaymentRequirements
          );
        } catch (error: any) {
          console.error("[payment] Facilitator settlement error", error);
          console.error("[payment] Settlement error details:", {
            message: error?.message,
            name: error?.name,
            stack: error?.stack?.substring(0, 500),
          });
          settlementError = true;
          // Continue with response even if settlement fails - payment was already verified
          console.warn("[payment] ⚠️ WARNING: Settlement failed - payment may not have been processed!");
          console.warn("[payment] Proceeding with response despite settlement error - payment was verified");
        }

        const headers = new Headers(appResponse.headers);
        
        // Ensure Content-Type is set to application/json if not already set
        if (!headers.has("Content-Type")) {
          headers.set("Content-Type", "application/json");
        }
        
        if (!settlementError && settlement && settlement.success) {
          const settlementHeader = settleResponseHeader(settlement);
          console.log(`[payment] Settlement succeeded:`, settlement);
          headers.set("X-PAYMENT-RESPONSE", settlementHeader);
        } else {
          console.warn("[payment] Settlement failed or skipped - proceeding without settlement header");
        }
        
        const responseWithHeader = new Response(appResponse.body, {
          status: appResponse.status,
          statusText: appResponse.statusText,
          headers,
        });

        const discordCallback = url.searchParams.get("discord_callback");

        if (discordCallback) {
          if (appResponseClone.status >= 200 && appResponseClone.status < 300) {
            try {
              const result = await appResponseClone.json();
              const serverHost = process.env.AGENT_URL
                ? new URL(process.env.AGENT_URL).origin
                : url.origin;
              const callbackUrl = `${serverHost}/discord-callback`;

              console.log(`[discord] Triggering callback to: ${callbackUrl}`);

              const callbackResponse = await fetch(callbackUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  discord_token: decodeURIComponent(discordCallback),
                  result,
                }),
              });

              if (!callbackResponse.ok) {
                const errorText = await callbackResponse.text();
                console.error(
                  `[discord] Callback failed: ${callbackResponse.status} ${errorText}`
                );
                console.error(`[discord] Callback URL was: ${callbackUrl}`);
              } else {
                console.log(`[discord] Callback successful`);
              }
            } catch (err) {
              console.error("[discord] Failed to parse entrypoint response:", err);
            }
          }

          return responseWithHeader;
        }

        return responseWithHeader;
      }
    }
    
    // Agent app routes
    return app.fetch(req);
  },
});

console.log(
  `🚀 Agent ready at http://${server.hostname}:${server.port}/.well-known/agent.json`
);
console.log(
  `📡 Discord interactions: http://${server.hostname}:${server.port}/interactions`
);

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const publicBaseUrl =
  process.env.PUBLIC_WEB_URL ||
  process.env.AGENT_URL ||
  `http://${server.hostname}:${server.port}`;

if (telegramToken) {
  if (!publicBaseUrl.startsWith("http")) {
    console.warn(
      "[telegram] PUBLIC_WEB_URL or AGENT_URL should be set to a full URL for Telegram payment links"
    );
  }

  (async () => {
    try {
      const bot = createTelegramBot({
        token: telegramToken,
        baseUrl: publicBaseUrl,
      });
      await bot.start();
      console.log("🤖 Telegram summariser bot ready");
    } catch (err: any) {
      // Handle 409 conflict gracefully (multiple instances running)
      if (err?.error_code === 409) {
        console.warn("[telegram] Bot already running elsewhere (409 conflict). Skipping local bot start.");
        console.warn("[telegram] This is normal if the bot is running on Railway or in another terminal.");
        return;
      }
      console.error("[telegram] Failed to start bot", err);
    }
  })();
} else {
  console.log("[telegram] TELEGRAM_BOT_TOKEN not set; Telegram bot disabled");
}
