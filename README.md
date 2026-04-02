# claude-feishu-notify

让 Claude Code 与飞书打通 —— 任务通知、等待输入通知等。

```
飞书用户 ←──→ 飞书机器人 ←──→ lark-cli ←──→ claude-feishu-notify ←──→ Claude Code
                                                  (MCP Server)
```
<img width="1758" alt="e93093899d3f391a132672261ed6938a" src="https://github.com/user-attachments/assets/48148c87-2e7d-47db-985e-14d25a6f5dab" />


## 功能

### MCP 工具（Claude Code 可直接调用）

| 工具 | 说明 |
|---|---|
| `feishu_send` | 发送消息到飞书用户或群聊（支持 Markdown） |
| `feishu_inbox` | 读取用户通过飞书机器人发来的消息队列 |
| `feishu_reply` | 回复指定飞书消息 |
| `feishu_status` | 查看桥接服务运行状态 |

### 智能通知卡片（自动触发）

| 场景 | 卡片样式 | 触发时机 |
|---|---|---|
| ✅ 任务完成 | 绿色卡片 + AI 摘要 | Claude Code 会话结束 |
| 🔐 请求授权 | 橙色卡片 | Claude Code 需要工具使用权限 |
| ⏳ 等待输入 | 蓝色卡片 | Claude Code 等待用户回复超 60 秒 |

任务完成通知会调用 Claude Haiku 生成一句话摘要，而非转发原始输出。

## 前置条件

1. **lark-cli** — 飞书命令行工具
   ```bash
   brew install larksuite/tap/lark-cli
   ```

2. **飞书应用** — 在 [飞书开放平台](https://open.feishu.cn) 创建应用并获取 App ID 和 App Secret
   ```bash
   lark-cli config init     # 配置 App ID / App Secret
   lark-cli auth login      # OAuth 登录
   ```

3. **飞书应用权限** — 在应用管理后台开通以下权限：
   - `im:message:send_as_bot` — 机器人发消息
   - `im:message.receive_v1` — 接收消息事件
   - `contact:user.base:readonly` — 读取用户信息（用于自动检测 open_id）

4. **Claude Code** — Anthropic 官方 CLI
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```

## 安装

一行命令完成所有配置：

```bash
npx claude-feishu-notify setup
```

安装向导会自动：
- 检测 lark-cli 和 claude 是否就绪
- 通过 lark-cli 自动获取你的飞书 open_id
- 注册 MCP Server 到 Claude Code
- 配置三种通知 Hook（任务完成、请求授权、等待输入）

安装完成后重启 Claude Code 即可。

## 手动配置

如果你希望手动配置而非使用安装向导：

### 1. 注册 MCP Server

```bash
claude mcp add feishu-bridge \
  -e FEISHU_NOTIFY_USER_ID="你的open_id" \
  -- npx -y claude-feishu-notify
```

### 2. 配置 Hooks

在 `~/.claude/settings.json` 中添加：

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [{ "type": "command", "command": "npx -y claude-feishu-notify notify --type permission" }]
      },
      {
        "matcher": "idle_prompt",
        "hooks": [{ "type": "command", "command": "npx -y claude-feishu-notify notify --type idle" }]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "npx -y claude-feishu-notify notify --type stop" }]
      }
    ]
  }
}
```

## 环境变量

| 变量 | 必填 | 说明 | 默认值 |
|---|---|---|---|
| `FEISHU_NOTIFY_USER_ID` | 是 | 接收通知的飞书用户 open_id (ou_xxx) | — |
| `LARK_CLI_BIN` | 否 | lark-cli 可执行文件路径 | `lark-cli` |
| `FEISHU_NOTIFY_TIMEZONE` | 否 | 通知卡片中显示的时区 | `Asia/Shanghai` |
| `ANTHROPIC_AUTH_TOKEN` | 否 | Anthropic API Key（用于 AI 摘要） | — |
| `ANTHROPIC_BASE_URL` | 否 | Anthropic API 地址 | `https://api.anthropic.com` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | 否 | 摘要使用的模型 | `claude-haiku-4-5-20251001` |

> 如果未配置 Anthropic API Key，任务完成通知会 fallback 到提取首行文本作为摘要。

## 使用

安装完成后，在 Claude Code 中：

```
> 检查飞书消息          # 拉取用户通过机器人发来的指令
> 给我发条飞书消息测试   # 测试发送功能
> 查看飞书桥接状态       # 检查服务运行状态
```

通知是自动的 —— 任务完成、等待输入、请求授权时会自动推送到飞书。

## CLI 命令

```bash
npx claude-feishu-notify           # 启动 MCP Server（Claude Code 自动调用）
npx claude-feishu-notify setup     # 交互式安装向导
npx claude-feishu-notify uninstall # 卸载（移除 MCP Server + Hooks + 环境变量）
npx claude-feishu-notify notify    # 处理 Hook 通知（Claude Code Hook 调用）
  --type stop                   #   任务完成通知
  --type permission             #   工具授权通知
  --type idle                   #   等待输入通知
  --type general                #   通用通知
```

## 卸载

```bash
# 1. 移除 MCP Server
claude mcp remove feishu-bridge

# 2. 清理 Hooks（删除 ~/.claude/settings.json 中 claude-feishu-notify 相关的 hooks）
npx claude-feishu-notify uninstall
# 或手动编辑 ~/.claude/settings.json，删除 Notification 和 Stop 中的 claude-feishu-notify 条目
```

## 工作原理

```
┌─────────────────────────────────────────────────────────────┐
│                        Claude Code                          │
│                                                             │
│  MCP Server (claude-feishu-notify)                             │
│  ├─ feishu_send   ──→ lark-cli im +messages-send ──→ 飞书  │
│  ├─ feishu_inbox  ←── lark-cli event +subscribe  ←── 飞书  │
│  ├─ feishu_reply  ──→ lark-cli im +messages-reply ─→ 飞书  │
│  └─ feishu_status                                           │
│                                                             │
│  Hooks                                                      │
│  ├─ Stop            ──→ notify --type stop       ──→ 飞书   │
│  ├─ permission_prompt → notify --type permission ──→ 飞书   │
│  └─ idle_prompt     ──→ notify --type idle       ──→ 飞书   │
└─────────────────────────────────────────────────────────────┘
```

- **发通知**：Claude Code Hook 事件 → `claude-feishu-notify notify` → Haiku AI 摘要 → 飞书卡片
- **收指令**：飞书用户发消息 → `lark-cli event +subscribe` WebSocket → 消息队列 → Claude 调用 `feishu_inbox`
- **发消息**：Claude 调用 `feishu_send` → `lark-cli im +messages-send` → 飞书

## License

MIT
