import { app, executeSummariseChat } from "./agent";
import nacl from "tweetnacl";

const port = Number(process.env.PORT ?? 8787);
const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const DISCORD_API_DEFAULT_BASE = "https://discord.com/api/v10";

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
    const { name, options, channel_id, guild_id } = interaction.data || {};

    if (name === "summarise") {
      // Get lookback minutes from options (default: 60)
      const lookbackOption = options?.find((opt: any) => opt.name === "minutes");
      const lookbackMinutes = lookbackOption?.value ?? 60;

      // Respond immediately with "thinking"
      const initialResponse = Response.json({
        type: 5, // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
      });

      // Process in background - route through x402 payment-enabled entrypoint
      (async () => {
        try {
          console.log(`[discord] Processing summarise command: channel=${channel_id}, guild=${guild_id}, minutes=${lookbackMinutes}`);
          
          const baseUrl =
            process.env.DISCORD_API_BASE_URL ?? DISCORD_API_DEFAULT_BASE;
          const followupUrl = `${baseUrl}/webhooks/${interaction.application_id}/${interaction.token}`;

          // Call the agent-kit entrypoint (which handles x402 payments)
          const agentBaseUrl = process.env.AGENT_URL || `https://x402-summariser-production.up.railway.app`;
          const entrypointUrl = `${agentBaseUrl}/entrypoints/summarise%20chat/invoke`;
          
          console.log(`[discord] Calling entrypoint: ${entrypointUrl}`);

          // Make request to entrypoint (without payment headers - it will return payment instructions)
          const entrypointResponse = await fetch(entrypointUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              input: {
                channelId: channel_id,
                serverId: guild_id,
                lookbackMinutes,
              },
            }),
          });

          const responseData = await entrypointResponse.json();

          // Check if payment is required
          if (entrypointResponse.status === 402 || responseData.error?.code === "payment_required") {
            // Send payment instructions to Discord user
            const paymentUrl = `${agentBaseUrl}/entrypoints/summarise%20chat/invoke`;
            const callbackWebhook = `${agentBaseUrl}/discord-callback?token=${interaction.token}&application_id=${interaction.application_id}`;
            
            const paymentMessage = `💳 **Payment Required**

To summarise this channel, please pay **0.05 ETH** via x402.

🔗 **Pay & Summarise:**
${paymentUrl}?channelId=${channel_id}&serverId=${guild_id}&lookbackMinutes=${lookbackMinutes}

After payment, your summary will appear here automatically.`;

            await fetch(followupUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                content: paymentMessage,
              }),
            });
            return;
          }

          if (!entrypointResponse.ok) {
            throw new Error(`Entrypoint error: ${entrypointResponse.status} ${JSON.stringify(responseData)}`);
          }

          // Success - format and send result
          const output = responseData.output || responseData;
          let content = `**Summary**\n${output.summary || "No summary available"}\n\n`;
          
          if (output.actionables && output.actionables.length > 0) {
            content += `**Action Items**\n${output.actionables.map((a: string, i: number) => `${i + 1}. ${a}`).join("\n")}`;
          } else {
            content += `*No action items identified.*`;
          }

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
