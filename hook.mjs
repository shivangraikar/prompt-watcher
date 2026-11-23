#!/usr/bin/env node
// Hook adapter. Agents run `node hook.mjs <agent>` from their hook config with the raw
// hook payload on stdin; this forwards it to the watcher. The server imports normalize().
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const WATCHER_HOME = process.env.WATCHER_HOME ?? path.dirname(fileURLToPath(import.meta.url));
export const SERVER_FILE = path.join(WATCHER_HOME, '.watcher', 'server.json');

const EVENT_TYPES = new Set(['user_message', 'tool_started', 'tool_finished']);
const MAX_FIELD_CHARS = 4000;

// Tool inputs/outputs can be whole files; keep the record readable.
function clip(value) {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  if (json === undefined || json.length <= MAX_FIELD_CHARS) return value;
  return `${json.slice(0, MAX_FIELD_CHARS)}… [truncated ${json.length - MAX_FIELD_CHARS} chars]`;
}

// Payload already in the README event shape (fixtures, tests, agents posting directly).
function normalizeCanonical(agent, raw) {
  if (!EVENT_TYPES.has(raw.type) || raw.session_id == null) return null;
  const event = {
    agent: String(raw.agent ?? agent),
    session_id: String(raw.session_id),
    type: raw.type,
    source_event_id: raw.event_id != null ? String(raw.event_id) : undefined,
    source_timestamp: raw.captured_at ?? raw.timestamp,
    source_prompt_id: raw.prompt_id != null ? String(raw.prompt_id) : undefined,
  };
  if (raw.type === 'user_message') {
    if (typeof raw.text !== 'string') return null;
    event.text = raw.text;
  } else {
    if (raw.tool?.call_id == null) return null;
    event.tool = { ...raw.tool, call_id: String(raw.tool.call_id), input: clip(raw.tool.input) };
  }
  return event;
}

// Claude Code hook payloads: https://code.claude.com/docs/en/hooks
function normalizeClaudeHook(agent, raw) {
  if (raw.session_id == null) return null;
  const base = {
    agent,
    session_id: String(raw.session_id),
    source_timestamp: raw.timestamp,
    source_prompt_id: raw.prompt_id,
  };
  const tool = { call_id: raw.tool_use_id, name: raw.tool_name };
  switch (raw.hook_event_name) {
    case 'UserPromptSubmit':
      return typeof raw.prompt === 'string' ? { ...base, type: 'user_message', text: raw.prompt } : null;
    case 'PreToolUse':
      return tool.call_id ? { ...base, type: 'tool_started', tool: { ...tool, input: clip(raw.tool_input) } } : null;
    case 'PostToolUse':
      return tool.call_id
        ? { ...base, type: 'tool_finished', tool: { ...tool, status: 'succeeded', output: clip(raw.tool_response) } }
        : null;
    case 'PostToolUseFailure':
      return tool.call_id
        ? { ...base, type: 'tool_finished', tool: { ...tool, status: raw.is_interrupt ? 'interrupted' : 'failed', error: clip(raw.error) } }
        : null;
    default:
      return null; // SessionStart, Stop, etc. are not part of the event stream
  }
}

// One adapter per agent. Each accepts its native hook payload or the canonical README shape.
export const ADAPTERS = {
  'claude-code': (raw) => (raw.hook_event_name ? normalizeClaudeHook('claude-code', raw) : normalizeCanonical('claude-code', raw)),
  // Unverified: assumes Codex hook payloads use Claude-style field names (hook_event_name, tool_use_id, ...).
  codex: (raw) => (raw.hook_event_name ? normalizeClaudeHook('codex', raw) : normalizeCanonical('codex', raw)),
};

// Returns a normalized event (without watcher-assigned ids) or null if the payload isn't one we record.
export function normalize(agent, raw) {
  const adapter = ADAPTERS[agent];
  if (!adapter || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return adapter(raw);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main() {
  const agent = process.argv[2];
  const body = await readStdin();
  let server;
  try {
    server = JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8'));
  } catch {
    return; // watcher not running: stay silent so the agent is unaffected
  }
  // Retries reuse the delivery id so the server can drop a duplicate if the first attempt landed.
  const deliveryId = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${server.port}/hook/${encodeURIComponent(agent)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-delivery-id': deliveryId },
        body,
        signal: AbortSignal.timeout(1500),
      });
      return;
    } catch {
      // fall through to retry
    }
  }
}

// Never print to stdout (Claude Code adds UserPromptSubmit stdout to the model's context) and always exit 0.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {}).finally(() => process.exit(0));
}
