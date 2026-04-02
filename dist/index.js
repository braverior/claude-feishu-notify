#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, execSync } from "node:child_process";
import { createInterface } from "node:readline";
const messageQueue = [];
const config = {
    notifyUserId: process.env.FEISHU_NOTIFY_USER_ID || "",
    larkCliBin: process.env.LARK_CLI_BIN || "lark-cli",
};
// --- Feishu Event Listener ---
let eventProcess = null;
function startEventListener() {
    if (eventProcess)
        return;
    const args = [
        "event",
        "+subscribe",
        "--event-types",
        "im.message.receive_v1",
        "--compact",
        "--quiet",
    ];
    eventProcess = spawn(config.larkCliBin, args, {
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (!eventProcess.stdout)
        return;
    const rl = createInterface({ input: eventProcess.stdout });
    rl.on("line", (line) => {
        try {
            const event = JSON.parse(line);
            const msg = parseFeishuEvent(event);
            if (msg) {
                messageQueue.push(msg);
                // Keep queue bounded
                if (messageQueue.length > 100) {
                    messageQueue.splice(0, messageQueue.length - 100);
                }
            }
        }
        catch {
            // Ignore non-JSON lines
        }
    });
    eventProcess.on("exit", (code) => {
        console.error(`[feishu-bridge] Event listener exited with code ${code}, restarting in 5s...`);
        eventProcess = null;
        setTimeout(startEventListener, 5000);
    });
    eventProcess.on("error", (err) => {
        console.error(`[feishu-bridge] Event listener error: ${err.message}`);
        eventProcess = null;
    });
    console.error("[feishu-bridge] Feishu event listener started");
}
function parseFeishuEvent(event) {
    try {
        // --compact mode flattens the event structure
        // Try compact format first
        const msgId = event.message_id ||
            event.event_id ||
            `msg_${Date.now()}`;
        const senderId = event.sender_id || "";
        const senderName = event.sender_name || event.name || "unknown";
        const chatId = event.chat_id || "";
        // Content can be in different fields depending on format
        let content = "";
        if (typeof event.text === "string") {
            content = event.text;
        }
        else if (typeof event.content === "string") {
            try {
                const parsed = JSON.parse(event.content);
                content = parsed.text || event.content;
            }
            catch {
                content = event.content;
            }
        }
        else if (typeof event.message === "object" && event.message) {
            const msg = event.message;
            if (typeof msg.content === "string") {
                try {
                    const parsed = JSON.parse(msg.content);
                    content = parsed.text || msg.content;
                }
                catch {
                    content = msg.content;
                }
            }
        }
        if (!content)
            return null;
        return {
            id: msgId,
            sender: senderId,
            senderName,
            chatId,
            content,
            timestamp: new Date().toISOString(),
            raw: event,
        };
    }
    catch {
        return null;
    }
}
// --- Shell Helpers ---
function shellQuote(s) {
    return "'" + s.replace(/'/g, "'\\''") + "'";
}
function shellEscape(args) {
    return args.map(shellQuote).join(" ");
}
// --- Lark CLI Helpers ---
function sendMessage(opts) {
    const args = [config.larkCliBin, "im", "+messages-send", "--as", "bot"];
    if (opts.chatId) {
        args.push("--chat-id", opts.chatId);
    }
    else if (opts.userId || config.notifyUserId) {
        args.push("--user-id", opts.userId || config.notifyUserId);
    }
    else {
        return "Error: no user_id or chat_id specified. Set FEISHU_NOTIFY_USER_ID or provide user_id/chat_id.";
    }
    if (opts.markdown) {
        args.push("--markdown", opts.markdown);
    }
    else if (opts.text) {
        args.push("--text", opts.text);
    }
    else {
        return "Error: no message content provided.";
    }
    try {
        const result = execSync(shellEscape(args), {
            encoding: "utf-8",
            timeout: 15000,
        });
        return result.trim() || "Message sent successfully.";
    }
    catch (err) {
        const error = err;
        return `Error sending message: ${error.stderr || error.message}`;
    }
}
// --- MCP Server ---
const server = new McpServer({
    name: "feishu-bridge",
    version: "1.0.0",
});
// Tool: Send a message to Feishu
server.tool("feishu_send", "Send a message to a Feishu user or chat. Use this to notify the user about task progress, ask questions, or share results.", {
    content: z
        .string()
        .describe("Message content (supports Markdown formatting)"),
    user_id: z
        .string()
        .optional()
        .describe("Target user open_id (ou_xxx). Falls back to FEISHU_NOTIFY_USER_ID if not provided."),
    chat_id: z
        .string()
        .optional()
        .describe("Target chat_id (oc_xxx). Takes priority over user_id."),
    format: z
        .enum(["text", "markdown"])
        .default("markdown")
        .describe("Message format: text or markdown"),
}, async ({ content, user_id, chat_id, format }) => {
    const opts = format === "markdown"
        ? { userId: user_id, chatId: chat_id, markdown: content }
        : { userId: user_id, chatId: chat_id, text: content };
    const result = sendMessage(opts);
    return { content: [{ type: "text", text: result }] };
});
// Tool: Check for new messages from Feishu
server.tool("feishu_inbox", "Check for new messages sent by the user via the Feishu bot. Call this periodically to see if the user has sent new instructions or feedback through Feishu.", {
    clear: z
        .boolean()
        .default(true)
        .describe("Clear messages from queue after reading (default: true)"),
}, async ({ clear }) => {
    if (messageQueue.length === 0) {
        return {
            content: [{ type: "text", text: "No new messages." }],
        };
    }
    const messages = [...messageQueue];
    if (clear) {
        messageQueue.length = 0;
    }
    const formatted = messages
        .map((m) => `[${m.timestamp}] ${m.senderName}: ${m.content}`)
        .join("\n");
    return {
        content: [
            {
                type: "text",
                text: `${messages.length} new message(s):\n\n${formatted}`,
            },
        ],
    };
});
// Tool: Reply to a specific Feishu message
server.tool("feishu_reply", "Reply to a specific Feishu message. Use when you want to respond directly to a message the user sent via the bot.", {
    message_id: z.string().describe("The message_id (om_xxx) to reply to"),
    content: z
        .string()
        .describe("Reply content (supports Markdown formatting)"),
}, async ({ message_id, content }) => {
    try {
        const args = [
            config.larkCliBin,
            "im",
            "+messages-reply",
            "--as",
            "bot",
            "--message-id",
            message_id,
            "--markdown",
            content,
        ];
        const result = execSync(shellEscape(args), {
            encoding: "utf-8",
            timeout: 15000,
        });
        return {
            content: [
                { type: "text", text: result.trim() || "Reply sent." },
            ],
        };
    }
    catch (err) {
        const error = err;
        return {
            content: [
                {
                    type: "text",
                    text: `Error replying: ${error.stderr || error.message}`,
                },
            ],
        };
    }
});
// Tool: Get current configuration status
server.tool("feishu_status", "Check the Feishu bridge status: event listener state, message queue size, and configuration.", {}, async () => {
    const status = {
        eventListener: eventProcess ? "running" : "stopped",
        queuedMessages: messageQueue.length,
        notifyUserId: config.notifyUserId || "(not set)",
        larkCliBin: config.larkCliBin,
    };
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(status, null, 2),
            },
        ],
    };
});
// --- Start ---
async function main() {
    // Start Feishu event listener
    startEventListener();
    // Connect MCP server via stdio
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[feishu-bridge] MCP server started on stdio");
}
main().catch((err) => {
    console.error("[feishu-bridge] Fatal error:", err);
    process.exit(1);
});
// Cleanup on exit
process.on("SIGINT", () => {
    eventProcess?.kill();
    process.exit(0);
});
process.on("SIGTERM", () => {
    eventProcess?.kill();
    process.exit(0);
});
