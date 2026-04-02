#!/usr/bin/env bash
# setup.sh — One-click setup for feishu-bridge-mcp
# Registers the MCP server and hooks in Claude Code settings.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCP_SERVER_PATH="$SCRIPT_DIR/dist/index.js"
HOOK_SCRIPT_PATH="$SCRIPT_DIR/hooks/feishu-notify.sh"

echo "=== Feishu Bridge MCP Setup ==="
echo ""

# 1. Check prerequisites
if ! command -v lark-cli &>/dev/null; then
  echo "Error: lark-cli not found. Install it first:"
  echo "  brew install larksuite/tap/lark-cli"
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo "Error: node not found."
  exit 1
fi

if ! command -v claude &>/dev/null; then
  echo "Error: claude (Claude Code CLI) not found."
  exit 1
fi

# 2. Build if needed
if [ ! -f "$MCP_SERVER_PATH" ]; then
  echo "Building MCP server..."
  cd "$SCRIPT_DIR"
  npm run build 2>/dev/null || npx tsc
fi

# 3. Auto-detect Feishu open_id via lark-cli
echo "Detecting your Feishu open_id..."
AUTO_USER_ID=$(lark-cli contact +get-user --as user 2>/dev/null \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const o=JSON.parse(d);process.stdout.write(o.data.user.open_id||'')}catch{}})" 2>/dev/null || true)
AUTO_USER_NAME=$(lark-cli contact +get-user --as user 2>/dev/null \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const o=JSON.parse(d);process.stdout.write(o.data.user.name||'')}catch{}})" 2>/dev/null || true)

if [ -n "$AUTO_USER_ID" ]; then
  echo "Found: $AUTO_USER_NAME ($AUTO_USER_ID)"
  read -p "Use this open_id? [Y/n]: " CONFIRM
  if [ "$CONFIRM" = "n" ] || [ "$CONFIRM" = "N" ]; then
    read -p "Enter your Feishu open_id (ou_xxx): " FEISHU_USER_ID
  else
    FEISHU_USER_ID="$AUTO_USER_ID"
  fi
else
  echo "Could not auto-detect. Make sure lark-cli is logged in (lark-cli auth login)."
  read -p "Enter your Feishu open_id (ou_xxx) or leave empty to skip: " FEISHU_USER_ID
fi

if [ -z "$FEISHU_USER_ID" ]; then
  echo "Warning: No user_id set. You can configure FEISHU_NOTIFY_USER_ID later."
fi

# 4. Register MCP server
echo ""
echo "Registering MCP server with Claude Code..."
claude mcp add feishu-bridge \
  -e FEISHU_NOTIFY_USER_ID="$FEISHU_USER_ID" \
  -e LARK_CLI_BIN="$(which lark-cli)" \
  -- node "$MCP_SERVER_PATH"

echo "MCP server registered."

# 5. Configure hooks
echo ""
echo "Configuring hooks..."

SETTINGS_FILE="$HOME/.claude/settings.json"

# Use node to safely merge hooks into settings.json
node -e "
const fs = require('fs');
const path = '$SETTINGS_FILE';
const hookScript = '$HOOK_SCRIPT_PATH';
const userId = '$FEISHU_USER_ID';
const larkBin = '$(which lark-cli)';

let settings = {};
try { settings = JSON.parse(fs.readFileSync(path, 'utf-8')); } catch {}

// Ensure hooks structure
if (!settings.hooks) settings.hooks = {};

const hookCmd = 'FEISHU_NOTIFY_USER_ID=\"' + userId + '\" LARK_CLI_BIN=\"' + larkBin + '\" \"' + hookScript + '\"';
const hookEntry = {
  matcher: '',
  hooks: [{ type: 'command', command: hookCmd }]
};

// Add/update Notification hook
if (!settings.hooks.Notification) settings.hooks.Notification = [];
const notifHooks = settings.hooks.Notification;
const existingNotif = notifHooks.findIndex(h => h.hooks && h.hooks.some(hh => hh.command && hh.command.includes('feishu-notify')));
if (existingNotif >= 0) {
  notifHooks[existingNotif] = hookEntry;
} else {
  notifHooks.push(hookEntry);
}

// Add/update Stop hook
if (!settings.hooks.Stop) settings.hooks.Stop = [];
const stopHooks = settings.hooks.Stop;
const existingStop = stopHooks.findIndex(h => h.hooks && h.hooks.some(hh => hh.command && hh.command.includes('feishu-notify')));
if (existingStop >= 0) {
  stopHooks[existingStop] = hookEntry;
} else {
  stopHooks.push(hookEntry);
}

// Ensure FEISHU env vars are set
if (!settings.env) settings.env = {};
settings.env.FEISHU_NOTIFY_USER_ID = userId;
settings.env.LARK_CLI_BIN = larkBin;

fs.writeFileSync(path, JSON.stringify(settings, null, 2));
console.log('Hooks configured in ' + path);
"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "What was configured:"
echo "  1. MCP Server: feishu-bridge (provides feishu_send, feishu_inbox, feishu_reply, feishu_status tools)"
echo "  2. Hooks: Notification and Stop events will be forwarded to Feishu"
echo "  3. Env: FEISHU_NOTIFY_USER_ID=$FEISHU_USER_ID"
echo ""
echo "Usage:"
echo "  - Claude Code will automatically have feishu_send/feishu_inbox tools available"
echo "  - Notifications and session-end events are auto-forwarded to Feishu"
echo "  - Tell Claude: 'check Feishu messages' to poll for new commands from the bot"
echo ""
echo "To verify: restart Claude Code and run 'feishu_status' tool"
