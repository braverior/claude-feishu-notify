import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function which(bin: string): string | null {
  try {
    return execSync(`which ${bin}`, { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", timeout: 15000 }).trim();
}

export async function runSetup(): Promise<void> {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   Feishu Bridge MCP - Setup Wizard   ║");
  console.log("╚══════════════════════════════════════╝");
  console.log();

  // 1. Check prerequisites
  console.log("🔍 检查前置依赖...");

  const larkBin = which("lark-cli");
  if (!larkBin) {
    console.error("❌ 未找到 lark-cli。请先安装:");
    console.error("   brew install larksuite/tap/lark-cli");
    console.error("   详情: https://github.com/larksuite/cli");
    process.exit(1);
  }
  console.log(`   ✅ lark-cli: ${larkBin}`);

  const claudeBin = which("claude");
  if (!claudeBin) {
    console.error("❌ 未找到 claude (Claude Code CLI)。请先安装:");
    console.error("   npm install -g @anthropic-ai/claude-code");
    process.exit(1);
  }
  console.log(`   ✅ claude: ${claudeBin}`);

  // 2. Auto-detect Feishu open_id
  console.log();
  console.log("🔍 检测飞书账号...");

  let userId = "";
  let userName = "";
  try {
    const result = run(`${larkBin} contact +get-user --as user`);
    const data = JSON.parse(result);
    if (data.ok && data.data?.user) {
      userId = data.data.user.open_id || "";
      userName = data.data.user.name || "";
    }
  } catch {
    /* auto-detect failed */
  }

  if (userId) {
    console.log(`   找到: ${userName} (${userId})`);
    const confirm = await ask("   使用该账号? [Y/n]: ");
    if (confirm.toLowerCase() === "n") {
      userId = await ask("   请输入你的飞书 open_id (ou_xxx): ");
    }
  } else {
    console.log("   ⚠️  无法自动检测，请确认已运行 lark-cli auth login");
    userId = await ask("   请输入你的飞书 open_id (ou_xxx): ");
  }

  if (!userId) {
    console.log("   ⚠️  未设置 open_id，你可以稍后通过环境变量 FEISHU_NOTIFY_USER_ID 配置");
  }

  // 3. Register MCP server
  console.log();
  console.log("📦 注册 MCP Server...");

  const envArgs = userId ? `-e FEISHU_NOTIFY_USER_ID="${userId}"` : "";
  try {
    run(`${claudeBin} mcp add feishu-bridge ${envArgs} -- npx -y claude-feishu-notify`);
    console.log("   ✅ MCP Server 已注册");
  } catch (err: unknown) {
    const e = err as { message?: string };
    // If already exists, try to remove and re-add
    if (e.message?.includes("already exists")) {
      run(`${claudeBin} mcp remove feishu-bridge`);
      run(`${claudeBin} mcp add feishu-bridge ${envArgs} -- npx -y claude-feishu-notify`);
      console.log("   ✅ MCP Server 已更新");
    } else {
      console.error(`   ❌ 注册失败: ${e.message}`);
    }
  }

  // 4. Configure hooks
  console.log();
  console.log("🔗 配置 Hooks...");

  const settingsPath = join(homedir(), ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      /* start fresh */
    }
  }

  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown[]>;

  const hookDefs = [
    { event: "Notification", matcher: "permission_prompt", type: "permission" },
    { event: "Notification", matcher: "idle_prompt", type: "idle" },
    { event: "Stop", matcher: "", type: "stop" },
  ];

  for (const def of hookDefs) {
    if (!hooks[def.event]) hooks[def.event] = [];
    const entries = hooks[def.event] as Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;

    const cmd = `npx -y claude-feishu-notify notify --type ${def.type}`;
    const hookEntry = { matcher: def.matcher, hooks: [{ type: "command", command: cmd }] };

    const existing = entries.findIndex((h) =>
      h.hooks?.some((hh) => hh.command?.includes("claude-feishu-notify notify")),
    );

    if (existing >= 0) {
      entries[existing] = hookEntry;
    } else {
      entries.push(hookEntry);
    }
  }

  // Set env vars
  if (!settings.env) settings.env = {};
  const env = settings.env as Record<string, string>;
  if (userId) env.FEISHU_NOTIFY_USER_ID = userId;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`   ✅ Hooks 已写入 ${settingsPath}`);

  // 5. Done
  console.log();
  console.log("╔══════════════════════════════════════╗");
  console.log("║          ✅ 安装完成！               ║");
  console.log("╚══════════════════════════════════════╝");
  console.log();
  console.log("已配置:");
  console.log("  📦 MCP Server: feishu-bridge");
  console.log("     工具: feishu_send / feishu_inbox / feishu_reply / feishu_status");
  console.log("  🔗 Hooks:");
  console.log("     ✅ 任务完成通知 (Stop → 绿色卡片)");
  console.log("     🔐 工具授权提醒 (permission_prompt → 橙色卡片)");
  console.log("     ⏳ 等待输入提醒 (idle_prompt → 蓝色卡片)");
  if (userId) {
    console.log(`  👤 飞书用户: ${userName || userId}`);
  }
  console.log();
  console.log("使用方法:");
  console.log("  重启 Claude Code 即可生效");
  console.log('  对 Claude 说 "检查飞书消息" 可拉取用户通过机器人发来的指令');
  console.log('  对 Claude 说 "给我发条飞书消息" 可测试发送功能');
}
