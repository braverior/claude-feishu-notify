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

  // 4. Select notification types
  console.log();
  console.log("📬 选择要接收的飞书通知类型：");
  console.log();

  const allHookDefs = [
    { key: "1", event: "Stop",         matcher: "",                 type: "stop",       icon: "✅", label: "任务完成通知",   desc: "Claude 完成任务后推送绿色卡片 + AI 摘要" },
    { key: "2", event: "Notification", matcher: "permission_prompt", type: "permission", icon: "🔐", label: "工具授权提醒",   desc: "Claude 需要权限时推送橙色卡片" },
    { key: "3", event: "Notification", matcher: "idle_prompt",       type: "idle",       icon: "⏳", label: "等待输入提醒",   desc: "Claude 等待你回复时推送蓝色卡片" },
  ];

  for (const h of allHookDefs) {
    console.log(`   [${h.key}] ${h.icon} ${h.label}`);
    console.log(`       ${h.desc}`);
  }

  console.log();
  const selection = await ask("   输入编号选择（如 1,3），直接回车全选: ");

  let selectedKeys: Set<string>;
  if (!selection) {
    selectedKeys = new Set(allHookDefs.map((h) => h.key));
  } else {
    selectedKeys = new Set(selection.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean));
  }

  const selectedHooks = allHookDefs.filter((h) => selectedKeys.has(h.key));

  if (selectedHooks.length === 0) {
    console.log("   ⚠️  未选择任何通知，跳过 Hooks 配置");
  } else {
    console.log();
    console.log(`   已选择: ${selectedHooks.map((h) => h.icon + " " + h.label).join("、")}`);
  }

  // 5. Configure hooks
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

  if (selectedHooks.length > 0) {
    if (!settings.hooks) settings.hooks = {};
    const hooks = settings.hooks as Record<string, unknown[]>;

    for (const def of selectedHooks) {
      if (!hooks[def.event]) hooks[def.event] = [];
      const entries = hooks[def.event] as Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;

      const cmd = `npx -y claude-feishu-notify notify --type ${def.type}`;
      const hookEntry = { matcher: def.matcher, hooks: [{ type: "command", command: cmd }] };

      const existing = entries.findIndex((h) =>
        h.matcher === def.matcher &&
        h.hooks?.some((hh) => hh.command?.includes("claude-feishu-notify notify")),
      );

      if (existing >= 0) {
        entries[existing] = hookEntry;
      } else {
        entries.push(hookEntry);
      }
    }
  }

  // Set env vars
  if (!settings.env) settings.env = {};
  const env = settings.env as Record<string, string>;
  if (userId) env.FEISHU_NOTIFY_USER_ID = userId;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`   ✅ 配置已写入 ${settingsPath}`);

  // 6. Done
  console.log();
  console.log("╔══════════════════════════════════════╗");
  console.log("║          ✅ 安装完成！               ║");
  console.log("╚══════════════════════════════════════╝");
  console.log();
  console.log("已配置:");
  console.log("  📦 MCP Server: feishu-bridge");
  console.log("     工具: feishu_send / feishu_inbox / feishu_reply / feishu_status");
  if (selectedHooks.length > 0) {
    console.log("  🔗 Hooks:");
    for (const h of selectedHooks) {
      console.log(`     ${h.icon} ${h.label}`);
    }
  } else {
    console.log("  🔗 Hooks: 未配置（仅 MCP 工具可用）");
  }
  if (userId) {
    console.log(`  👤 飞书用户: ${userName || userId}`);
  }
  console.log();
  console.log("使用方法:");
  console.log("  重启 Claude Code 即可生效");
  console.log('  对 Claude 说 "检查飞书消息" 可拉取用户通过机器人发来的指令');
  console.log('  对 Claude 说 "给我发条飞书消息" 可测试发送功能');
}

export async function runUninstall(): Promise<void> {
  console.log("╔══════════════════════════════════════╗");
  console.log("║  Feishu Bridge MCP - Uninstall       ║");
  console.log("╚══════════════════════════════════════╝");
  console.log();

  // 1. Remove MCP server
  console.log("📦 移除 MCP Server...");
  const claudeBin = which("claude");
  if (claudeBin) {
    try {
      run(`${claudeBin} mcp remove feishu-bridge`);
      console.log("   ✅ MCP Server 已移除");
    } catch {
      console.log("   ⚠️  MCP Server 不存在或已移除");
    }
  } else {
    console.log("   ⚠️  未找到 claude CLI，跳过 MCP 移除");
  }

  // 2. Clean hooks from settings.json
  console.log();
  console.log("🔗 清理 Hooks...");

  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (!existsSync(settingsPath)) {
    console.log("   ⚠️  未找到 settings.json，跳过");
  } else {
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      console.log("   ⚠️  settings.json 解析失败，跳过");
      return;
    }

    const hooks = settings.hooks as Record<string, unknown[]> | undefined;
    if (hooks) {
      for (const event of Object.keys(hooks)) {
        const entries = hooks[event] as Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
        hooks[event] = entries.filter(
          (h) => !h.hooks?.some((hh) => hh.command?.includes("claude-feishu-notify")),
        );
        if ((hooks[event] as unknown[]).length === 0) {
          delete hooks[event];
        }
      }
      if (Object.keys(hooks).length === 0) {
        settings.hooks = {};
      }
    }

    // Clean env vars
    const env = settings.env as Record<string, string> | undefined;
    if (env) {
      delete env.FEISHU_NOTIFY_USER_ID;
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log(`   ✅ Hooks 已从 ${settingsPath} 中移除`);
  }

  // 3. Done
  console.log();
  console.log("╔══════════════════════════════════════╗");
  console.log("║          ✅ 卸载完成！               ║");
  console.log("╚══════════════════════════════════════╝");
  console.log();
  console.log("已清理:");
  console.log("  📦 MCP Server: feishu-bridge");
  console.log("  🔗 所有 claude-feishu-notify 相关 Hooks");
  console.log("  🔑 环境变量 FEISHU_NOTIFY_USER_ID");
  console.log();
  console.log("重启 Claude Code 即可生效。");
}
