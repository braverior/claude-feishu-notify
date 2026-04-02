import { execSync } from "node:child_process";
import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";

const LARK_CLI = process.env.LARK_CLI_BIN || "lark-cli";
const USER_ID = process.env.FEISHU_NOTIFY_USER_ID || "";
const TIMEZONE = process.env.FEISHU_NOTIFY_TIMEZONE || "Asia/Shanghai";

// --- Card builders ---

interface CardElement {
  tag: string;
  content?: string;
  flex_mode?: string;
  background_style?: string;
  columns?: CardElement[];
  width?: string;
  weight?: number;
  vertical_align?: string;
  elements?: CardElement[];
}

function md(content: string): CardElement {
  return { tag: "markdown", content };
}

function hr(): CardElement {
  return { tag: "hr" };
}

function columns(pairs: [string, string][]): CardElement {
  return {
    tag: "column_set",
    flex_mode: "none",
    background_style: "grey",
    columns: pairs.map(([label, value]) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      vertical_align: "top",
      elements: [{ tag: "markdown", content: `**${label}**\n${value || "-"}` }],
    })),
  };
}

function buildCard(header: string, template: string, elements: CardElement[]) {
  return {
    header: { title: { tag: "plain_text", content: header }, template },
    elements,
  };
}

// --- AI summary ---

async function aiSummarize(text: string): Promise<string> {
  if (!text || text.length < 10) return "会话已结束";

  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "";
  const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  if (!apiKey) return fallbackTitle(text);

  const truncated = text.length > 2000 ? text.substring(0, 2000) + "..." : text;
  const body = JSON.stringify({
    model: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || "claude-haiku-4-5-20251001",
    max_tokens: 150,
    messages: [{ role: "user", content: `请用一句简洁的中文（30-80字）总结以下 Claude Code 的工作内容。直接输出总结，不要前缀。\n\n${truncated}` }],
  });

  const url = new URL(baseUrl + "/v1/messages");
  const mod = url.protocol === "https:" ? https : http;

  return new Promise((resolve) => {
    const req = mod.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      timeout: 10000,
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const r = JSON.parse(data);
          const t = r.content?.[0]?.text;
          resolve(t && t.length > 5 ? t.trim() : fallbackTitle(text));
        } catch {
          resolve(fallbackTitle(text));
        }
      });
    });
    req.on("error", () => resolve(fallbackTitle(text)));
    req.on("timeout", () => { req.destroy(); resolve(fallbackTitle(text)); });
    req.write(body);
    req.end();
  });
}

function fallbackTitle(text: string): string {
  if (!text) return "会话已结束";
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^[`|\-=>]/.test(line) && !/^#+ .+/.test(line)) continue;
    const clean = line.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim();
    if (clean.length >= 4) return clean.length > 80 ? clean.substring(0, 77) + "..." : clean;
  }
  return lines[0]?.substring(0, 80) || "会话已结束";
}

// --- Send card ---

function sendCard(card: object): void {
  if (!USER_ID) {
    console.error("[feishu-bridge] FEISHU_NOTIFY_USER_ID not set, skipping notification");
    return;
  }
  const json = JSON.stringify(card);
  const shellQuote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  const cmd = [LARK_CLI, "im", "+messages-send", "--as", "bot", "--user-id", USER_ID, "--msg-type", "interactive", "--content", json]
    .map(shellQuote).join(" ");
  try {
    execSync(cmd, { encoding: "utf-8", timeout: 15000 });
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    console.error(`[feishu-bridge] Failed to send card: ${e.stderr || e.message}`);
  }
}

// --- Main ---

export async function handleNotify(type: string): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(input);
  } catch {
    console.error("[feishu-bridge] Failed to parse hook event JSON from stdin");
    process.exit(1);
  }

  const hookEvent = (event.hook_event_name as string) || "";
  const cwd = (event.cwd as string) || "";
  const project = cwd ? cwd.split("/").pop()! : "";
  const lastMsg = ((event.last_assistant_message as string) || "").trim();
  const now = new Date().toLocaleString("zh-CN", { timeZone: TIMEZONE, hour12: false });

  // Resolve effective type
  const effectiveType = type || (hookEvent === "Stop" ? "stop" : "general");

  let card: object;

  switch (effectiveType) {
    case "stop": {
      const summary = await aiSummarize(lastMsg);
      card = buildCard("✅ Claude Code 任务已完成", "green", [
        md(`📋 **任务摘要**\n${summary}`),
        hr(),
        columns([["📁 项目", project || "-"], ["⏰ 完成时间", now]]),
      ]);
      break;
    }
    case "permission": {
      const detail = lastMsg.length > 300 ? lastMsg.substring(0, 300) + "..." : lastMsg;
      card = buildCard("🔐 Claude Code 请求工具授权", "orange", [
        md("Claude Code 正在请求工具使用权限，请前往终端确认。"),
        hr(),
        md(`💬 **当前操作**\n${detail || "(无详细信息)"}`),
        hr(),
        columns([["📁 项目", project || "-"], ["⏰ 时间", now]]),
      ]);
      break;
    }
    case "idle": {
      const question = lastMsg.length > 500 ? lastMsg.substring(0, 500) + "..." : lastMsg;
      card = buildCard("⏳ Claude Code 等待您的输入", "blue", [
        md("Claude Code 已完成当前步骤，正在等待您的回复。"),
        hr(),
        md(`💬 **Claude 的提问**\n${question || "(请前往终端查看)"}`),
        hr(),
        columns([["📁 项目", project || "-"], ["⏰ 时间", now]]),
      ]);
      break;
    }
    default: {
      const msg = lastMsg.length > 500 ? lastMsg.substring(0, 500) + "..." : lastMsg;
      card = buildCard("💬 Claude Code 通知", "blue", [
        md(msg || "(无详细内容)"),
        hr(),
        columns([["📁 项目", project || "-"], ["⏰ 时间", now]]),
      ]);
    }
  }

  sendCard(card);
}
