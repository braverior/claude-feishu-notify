import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

// --- Types ---

interface FeishuMessage {
  id: string;
  sender: string;
  senderName: string;
  chatId: string;
  content: string;
  timestamp: string;
  raw?: Record<string, unknown>;
}

interface Config {
  notifyUserId: string;
  larkCliBin: string;
}

// --- State ---

const messageQueue: FeishuMessage[] = [];
let eventProcess: ChildProcess | null = null;

const config: Config = {
  notifyUserId: process.env.FEISHU_NOTIFY_USER_ID || "",
  larkCliBin: process.env.LARK_CLI_BIN || "lark-cli",
};

// --- Shell Helpers ---

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function shellEscape(args: string[]): string {
  return args.map(shellQuote).join(" ");
}

// --- Feishu Event Listener ---

function startEventListener(): void {
  if (eventProcess) return;

  eventProcess = spawn(
    config.larkCliBin,
    ["event", "+subscribe", "--event-types", "im.message.receive_v1", "--compact", "--quiet"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  if (!eventProcess.stdout) return;

  const rl = createInterface({ input: eventProcess.stdout });
  rl.on("line", (line: string) => {
    try {
      const msg = parseFeishuEvent(JSON.parse(line));
      if (msg) {
        messageQueue.push(msg);
        if (messageQueue.length > 100) messageQueue.splice(0, messageQueue.length - 100);
      }
    } catch {
      /* ignore non-JSON */
    }
  });

  eventProcess.on("exit", (code) => {
    console.error(`[feishu-bridge] Event listener exited (code ${code}), restarting in 5s...`);
    eventProcess = null;
    setTimeout(startEventListener, 5000);
  });

  eventProcess.on("error", (err) => {
    console.error(`[feishu-bridge] Event listener error: ${err.message}`);
    eventProcess = null;
  });

  console.error("[feishu-bridge] Feishu event listener started");
}

function parseFeishuEvent(event: Record<string, unknown>): FeishuMessage | null {
  try {
    const msgId = (event.message_id as string) || (event.event_id as string) || `msg_${Date.now()}`;
    const senderId = (event.sender_id as string) || "";
    const senderName = (event.sender_name as string) || (event.name as string) || "unknown";
    const chatId = (event.chat_id as string) || "";

    let content = "";
    if (typeof event.text === "string") {
      content = event.text;
    } else if (typeof event.content === "string") {
      try {
        content = JSON.parse(event.content).text || event.content;
      } catch {
        content = event.content;
      }
    } else if (typeof event.message === "object" && event.message) {
      const msg = event.message as Record<string, unknown>;
      if (typeof msg.content === "string") {
        try {
          content = JSON.parse(msg.content).text || msg.content;
        } catch {
          content = msg.content;
        }
      }
    }

    if (!content) return null;
    return { id: msgId, sender: senderId, senderName, chatId, content, timestamp: new Date().toISOString(), raw: event };
  } catch {
    return null;
  }
}

// --- Lark CLI Helpers ---

function sendMessage(opts: { userId?: string; chatId?: string; text?: string; markdown?: string }): string {
  const args = [config.larkCliBin, "im", "+messages-send", "--as", "bot"];

  if (opts.chatId) {
    args.push("--chat-id", opts.chatId);
  } else if (opts.userId || config.notifyUserId) {
    args.push("--user-id", opts.userId || config.notifyUserId);
  } else {
    return "Error: no user_id or chat_id specified. Set FEISHU_NOTIFY_USER_ID env or provide user_id/chat_id.";
  }

  if (opts.markdown) args.push("--markdown", opts.markdown);
  else if (opts.text) args.push("--text", opts.text);
  else return "Error: no message content provided.";

  try {
    return execSync(shellEscape(args), { encoding: "utf-8", timeout: 15000 }).trim() || "Message sent successfully.";
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    return `Error sending message: ${e.stderr || e.message}`;
  }
}

// --- MCP Server ---

export async function startServer(): Promise<void> {
  const server = new McpServer({ name: "feishu-bridge", version: "1.0.0" });

  server.tool(
    "feishu_send",
    "Send a message to a Feishu user or chat. Supports Markdown.",
    {
      content: z.string().describe("Message content (supports Markdown)"),
      user_id: z.string().optional().describe("Target user open_id (ou_xxx). Falls back to FEISHU_NOTIFY_USER_ID."),
      chat_id: z.string().optional().describe("Target chat_id (oc_xxx). Takes priority over user_id."),
      format: z.enum(["text", "markdown"]).default("markdown").describe("Message format"),
    },
    async ({ content, user_id, chat_id, format }) => {
      const opts = format === "markdown"
        ? { userId: user_id, chatId: chat_id, markdown: content }
        : { userId: user_id, chatId: chat_id, text: content };
      return { content: [{ type: "text" as const, text: sendMessage(opts) }] };
    },
  );

  server.tool(
    "feishu_inbox",
    "Check for new messages from the Feishu bot. Call this to see if the user sent new instructions.",
    {
      clear: z.boolean().default(true).describe("Clear messages from queue after reading"),
    },
    async ({ clear }) => {
      if (messageQueue.length === 0) {
        return { content: [{ type: "text" as const, text: "No new messages." }] };
      }
      const messages = [...messageQueue];
      if (clear) messageQueue.length = 0;
      const formatted = messages.map((m) => `[${m.timestamp}] ${m.senderName}: ${m.content}`).join("\n");
      return { content: [{ type: "text" as const, text: `${messages.length} new message(s):\n\n${formatted}` }] };
    },
  );

  server.tool(
    "feishu_reply",
    "Reply to a specific Feishu message.",
    {
      message_id: z.string().describe("The message_id (om_xxx) to reply to"),
      content: z.string().describe("Reply content (supports Markdown)"),
    },
    async ({ message_id, content }) => {
      try {
        const args = [config.larkCliBin, "im", "+messages-reply", "--as", "bot", "--message-id", message_id, "--markdown", content];
        const result = execSync(shellEscape(args), { encoding: "utf-8", timeout: 15000 });
        return { content: [{ type: "text" as const, text: result.trim() || "Reply sent." }] };
      } catch (err: unknown) {
        const e = err as { stderr?: string; message?: string };
        return { content: [{ type: "text" as const, text: `Error replying: ${e.stderr || e.message}` }] };
      }
    },
  );

  server.tool(
    "feishu_status",
    "Check the Feishu bridge status: event listener, queue size, config.",
    {},
    async () => ({
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          eventListener: eventProcess ? "running" : "stopped",
          queuedMessages: messageQueue.length,
          notifyUserId: config.notifyUserId || "(not set)",
          larkCliBin: config.larkCliBin,
        }, null, 2),
      }],
    }),
  );

  startEventListener();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[feishu-bridge] MCP server started on stdio");
}
