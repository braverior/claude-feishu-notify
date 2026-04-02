#!/usr/bin/env bash
# feishu-notify.sh — Claude Code hook script
# Sends rich card notifications to Feishu with AI-powered summaries.
#
# Environment:
#   FEISHU_NOTIFY_USER_ID  — target user open_id (required)
#   FEISHU_NOTIFY_TYPE     — notification subtype: stop | permission | idle | general (default: general)
#   LARK_CLI_BIN           — path to lark-cli (default: lark-cli)
#   ANTHROPIC_AUTH_TOKEN   — API key for AI summary
#   ANTHROPIC_BASE_URL     — API base URL

set -euo pipefail

LARK_CLI="${LARK_CLI_BIN:-lark-cli}"
USER_ID="${FEISHU_NOTIFY_USER_ID:-}"
NOTIFY_TYPE="${FEISHU_NOTIFY_TYPE:-general}"

if [ -z "$USER_ID" ]; then
  exit 0
fi

INPUT=$(cat)

# Build card JSON via node (with optional AI summary for Stop events)
CARD_JSON=$(echo "$INPUT" | node -e "
const https = require('https');
const http = require('http');
const { URL } = require('url');

let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', async () => {
  try {
    const e = JSON.parse(d);
    const notifyType = '${NOTIFY_TYPE}';
    const event = e.hook_event_name || '';
    const cwd = e.cwd || '';
    const project = cwd ? cwd.split('/').pop() : '';
    const lastMsg = (e.last_assistant_message || '').trim();
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

    let header, headerTemplate, fields;

    if (event === 'Stop' || notifyType === 'stop') {
      // --- Task Completed ---
      const summary = await aiSummarize(lastMsg);
      header = '✅ Claude Code 任务已完成';
      headerTemplate = 'green';
      fields = [
        mdEl('📋 **任务摘要**\n' + summary),
        divider(),
        columnEl([
          ['📁 项目', project || '-'],
          ['⏰ 完成时间', now],
        ]),
      ];

    } else if (notifyType === 'permission') {
      // --- Permission Request ---
      header = '🔐 Claude Code 请求工具授权';
      headerTemplate = 'orange';
      const detail = lastMsg.length > 300 ? lastMsg.substring(0, 300) + '...' : lastMsg;
      fields = [
        mdEl('Claude Code 正在请求工具使用权限，请前往终端确认。'),
        divider(),
        mdEl('💬 **当前操作**\n' + (detail || '(无详细信息)')),
        divider(),
        columnEl([
          ['📁 项目', project || '-'],
          ['⏰ 时间', now],
        ]),
      ];

    } else if (notifyType === 'idle') {
      // --- Waiting for User Input ---
      header = '⏳ Claude Code 等待您的输入';
      headerTemplate = 'blue';
      const question = lastMsg.length > 500 ? lastMsg.substring(0, 500) + '...' : lastMsg;
      fields = [
        mdEl('Claude Code 已完成当前步骤，正在等待您的回复。'),
        divider(),
        mdEl('💬 **Claude 的提问**\n' + (question || '(请前往终端查看)')),
        divider(),
        columnEl([
          ['📁 项目', project || '-'],
          ['⏰ 时间', now],
        ]),
      ];

    } else {
      // --- General Notification ---
      header = '💬 Claude Code 通知';
      headerTemplate = 'blue';
      const msg = lastMsg.length > 500 ? lastMsg.substring(0, 500) + '...' : lastMsg;
      fields = [
        mdEl(msg || '(无详细内容)'),
        divider(),
        columnEl([
          ['📁 项目', project || '-'],
          ['⏰ 时间', now],
        ]),
      ];
    }

    const card = {
      header: {
        title: { tag: 'plain_text', content: header },
        template: headerTemplate,
      },
      elements: fields,
    };

    process.stdout.write(JSON.stringify(card));
  } catch(err) {
    // Fallback minimal card
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    process.stdout.write(JSON.stringify({
      header: { title: { tag: 'plain_text', content: '💬 Claude Code 通知' }, template: 'blue' },
      elements: [{ tag: 'markdown', content: '(解析失败)\\n⏰ ' + now }],
    }));
  }
});

// --- Helpers ---

function mdEl(content) {
  return { tag: 'markdown', content };
}

function divider() {
  return { tag: 'hr' };
}

function columnEl(pairs) {
  // Two-column layout using column_set
  return {
    tag: 'column_set',
    flex_mode: 'none',
    background_style: 'grey',
    columns: pairs.map(([label, value]) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_align: 'top',
      elements: [{ tag: 'markdown', content: '**' + label + '**\n' + (value || '-') }],
    })),
  };
}

// --- AI Summary ---

function aiSummarize(text) {
  if (!text || text.length < 10) return Promise.resolve('会话已结束');

  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '';
  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  if (!apiKey) return Promise.resolve(fallback(text));

  const truncated = text.length > 2000 ? text.substring(0, 2000) + '...' : text;
  const body = JSON.stringify({
    model: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    messages: [{
      role: 'user',
      content: '请用一句简洁的中文（30-80字）总结以下 Claude Code 的工作内容。直接输出总结，不要前缀。\n\n' + truncated,
    }],
  });

  const url = new URL(baseUrl + '/v1/messages');
  const mod = url.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const req = mod.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          const t = r.content && r.content[0] && r.content[0].text;
          resolve(t && t.length > 5 ? t.trim() : fallback(text));
        } catch { resolve(fallback(text)); }
      });
    });
    req.on('error', () => resolve(fallback(text)));
    req.on('timeout', () => { req.destroy(); resolve(fallback(text)); });
    req.write(body);
    req.end();
  });
}

function fallback(text) {
  if (!text) return '会话已结束';
  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^[\`\|\-\=\>]/.test(line) && !/^\#+ .+/.test(line)) continue;
    let c = line.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();
    if (c.length >= 4) return c.length > 80 ? c.substring(0, 77) + '...' : c;
  }
  return lines[0] ? lines[0].substring(0, 80) : '会话已结束';
}
" 2>/dev/null)

if [ -z "$CARD_JSON" ]; then
  exit 0
fi

"$LARK_CLI" im +messages-send \
  --as bot \
  --user-id "$USER_ID" \
  --msg-type interactive \
  --content "$CARD_JSON" \
  2>/dev/null || true
