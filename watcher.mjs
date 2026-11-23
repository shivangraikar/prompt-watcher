#!/usr/bin/env node
// Prompt Watcher: CLI (start/on/off/stop/status) and the local HTTP server that `start` runs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ADAPTERS, normalize, WATCHER_HOME, SERVER_FILE } from './hook.mjs';

const RUNS_DIR = path.join(WATCHER_HOME, 'runs');
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

const logPath = (runId) => path.join(RUNS_DIR, `${runId}.events.jsonl`);
const exportPath = (runId) => path.join(RUNS_DIR, `${runId}.json`);
// An (agent, session) pair identifies a session; event ids from agents are only unique inside one.
const scopeKey = (e) => JSON.stringify([e.agent, e.session_id]);

let run; // the active run (one per server process)
let server;

// ---------- helpers ----------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Write-then-rename so a crash never leaves a half-written file.
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const match = args[i].match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) continue;
    flags[match[1]] = match[2] ?? args[++i];
  }
  return flags;
}

function newRunId() {
  // e.g. run-20261123T175100Z
  const base = `run-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
  let id = base;
  for (let n = 2; fs.existsSync(logPath(id)) || fs.existsSync(exportPath(id)); n++) id = `${base}-${n}`;
  return id;
}

// An unfinished run has an event log but no export. Prefer the one the last server recorded.
function findUnfinishedRun() {
  const isUnfinished = (id) => fs.existsSync(logPath(id)) && !fs.existsSync(exportPath(id));
  const last = readJson(SERVER_FILE)?.run_id;
  if (last && isUnfinished(last)) return last;
  const candidates = fs
    .readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.events.jsonl'))
    .map((f) => f.slice(0, -'.events.jsonl'.length))
    .filter(isUnfinished)
    .sort((a, b) => fs.statSync(logPath(b)).mtimeMs - fs.statSync(logPath(a)).mtimeMs);
  return candidates[0] ?? null;
}

// ---------- run state ----------

function createRun(runId) {
  return {
    runId,
    capture: false,
    startedAt: new Date().toISOString(),
    events: [], // capture order
    seen: new Set(), // dedup keys
    sessionPrompt: new Map(), // scope -> event_id of the latest captured prompt
    sourcePrompt: new Map(), // scope|agent's prompt id -> our event_id
    callPrompt: new Map(), // scope|call_id -> prompt event_id (or null), set on tool_started
    clients: new Set(), // open SSE responses
  };
}

function dedupKey(e) {
  const scope = scopeKey(e);
  if (e.source_event_id) return `${scope}|event:${e.source_event_id}`;
  if (e.tool) return `${scope}|${e.type}:${e.tool.call_id}`;
  return null; // prompts without an agent event id fall back to delivery id or payload hash
}

function findPrompt(e) {
  const scope = scopeKey(e);
  // A result belongs to whichever prompt its call started under; unknown call -> ungrouped.
  if (e.type === 'tool_finished') return run.callPrompt.get(`${scope}|${e.tool.call_id}`) ?? null;
  // The agent told us its prompt id; if we never captured that prompt, don't guess.
  if (e.source_prompt_id) return run.sourcePrompt.get(`${scope}|${e.source_prompt_id}`) ?? null;
  return run.sessionPrompt.get(scope) ?? null;
}

// Update in-memory indexes. Used for both live events and log replay.
function apply(event) {
  const scope = scopeKey(event);
  if (event.type === 'user_message') {
    run.sessionPrompt.set(scope, event.event_id);
    if (event.source_prompt_id) run.sourcePrompt.set(`${scope}|${event.source_prompt_id}`, event.event_id);
  } else if (event.type === 'tool_started') {
    run.callPrompt.set(`${scope}|${event.tool.call_id}`, event.prompt_id);
  }
  run.seen.add(event.dedup_key);
  run.events.push(event);
}

// Returns false if the event is a duplicate.
function record(e, fallbackKey) {
  const dedup_key = dedupKey(e) ?? fallbackKey;
  if (run.seen.has(dedup_key)) return false;
  // undefined fields are dropped by JSON.stringify, so optional fields need no special casing
  const event = {
    event_id: `evt-${run.events.length + 1}`,
    agent: e.agent,
    session_id: e.session_id,
    captured_at: new Date().toISOString(),
    source_timestamp: e.source_timestamp,
    type: e.type,
    text: e.text,
    tool: e.tool,
    prompt_id: e.type === 'user_message' ? null : findPrompt(e),
    source_event_id: e.source_event_id,
    source_prompt_id: e.source_prompt_id,
    dedup_key,
  };
  fs.appendFileSync(logPath(run.runId), JSON.stringify(event) + '\n'); // persist before acknowledging
  apply(event);
  const frame = sseFrame(event);
  for (const client of run.clients) client.write(frame);
  return true;
}

function loadLog() {
  const file = logPath(run.runId);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '');
    return false;
  }
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // a crash mid-write can leave a torn last line
    }
    if (!run.seen.has(event.dedup_key)) apply(event);
  }
  // Terminate a torn line so the next append starts on a fresh line instead of corrupting it.
  if (text.length && !text.endsWith('\n')) fs.appendFileSync(file, '\n');
  run.sessionPrompt.clear(); // capture restarts off, so no prompt is "current" any more
  return true;
}

// ---------- views ----------

function publicEvent(event) {
  const { dedup_key, ...rest } = event;
  return rest;
}

function summarize(events) {
  return {
    coding_agents: new Set(events.map((e) => e.agent)).size,
    agent_sessions: new Set(events.map(scopeKey)).size,
    prompts: events.filter((e) => e.type === 'user_message').length,
  };
}

function buildExport() {
  const prompts = [];
  const promptsById = new Map();
  const ungrouped = [];
  for (const e of run.events) {
    if (e.type === 'user_message') {
      const prompt = {
        agent: e.agent,
        session_id: e.session_id,
        event_id: e.event_id,
        captured_at: e.captured_at,
        source_timestamp: e.source_timestamp,
        type: e.type,
        text: e.text,
        events: [],
      };
      prompts.push(prompt);
      promptsById.set(e.event_id, prompt);
      continue;
    }
    const item = { event_id: e.event_id, captured_at: e.captured_at, source_timestamp: e.source_timestamp, type: e.type, tool: e.tool };
    const prompt = e.prompt_id && promptsById.get(e.prompt_id);
    if (prompt) prompt.events.push(item);
    else ungrouped.push({ agent: e.agent, session_id: e.session_id, ...item });
  }
  return { run_id: run.runId, prompts, ungrouped_events: ungrouped, summary: summarize(run.events) };
}

function stateView() {
  return {
    run_id: run.runId,
    capture: run.capture ? 'on' : 'off',
    started_at: run.startedAt,
    port: server.address().port,
    pid: process.pid,
    counts: {
      events: run.events.length,
      ...summarize(run.events),
      ungrouped_events: run.events.filter((e) => e.type !== 'user_message' && !e.prompt_id).length,
      stream_clients: run.clients.size,
    },
  };
}

function sseFrame(event) {
  return `id: ${event.event_id}\ndata: ${JSON.stringify(publicEvent(event))}\n\n`;
}

// ---------- HTTP ----------

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2) + '\n');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// A body is one JSON payload, a JSON array of payloads, or NDJSON (bad lines skipped).
function parsePayloads(body) {
  try {
    const value = JSON.parse(body);
    return { items: Array.isArray(value) ? value : [value], invalid: 0 };
  } catch {}
  const items = [];
  let invalid = 0;
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      items.push(JSON.parse(line));
    } catch {
      invalid++;
    }
  }
  return { items, invalid };
}

async function handleHook(req, res, agent) {
  if (!ADAPTERS[agent]) return sendJson(res, 404, { error: `unknown agent "${agent}"`, agents: Object.keys(ADAPTERS) });
  const body = await readBody(req);
  if (!run.capture) return sendJson(res, 202, { captured: false });
  const { items, invalid } = parsePayloads(body);
  const deliveryId = req.headers['x-delivery-id'];
  const result = { captured: true, recorded: 0, duplicates: 0, ignored: 0, invalid };
  items.forEach((item, index) => {
    const event = normalize(agent, item);
    if (!event) return result.ignored++;
    const fallbackKey = deliveryId
      ? `delivery:${deliveryId}:${index}`
      : `hash:${crypto.createHash('sha256').update(agent + JSON.stringify(item)).digest('hex')}`;
    record(event, fallbackKey) ? result.recorded++ : result.duplicates++;
  });
  sendJson(res, items.length === 0 && invalid > 0 ? 400 : 200, result);
}

function handleStream(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(': connected\n\n');
  // Reconnecting EventSource clients send Last-Event-ID; replay only what they missed.
  const lastId = req.headers['last-event-id'];
  const from = lastId ? run.events.findIndex((e) => e.event_id === lastId) + 1 : 0;
  for (const event of run.events.slice(from)) res.write(sseFrame(event));
  run.clients.add(res);
  req.on('close', () => run.clients.delete(res));
}

async function handleControl(req, res) {
  let action;
  try {
    action = JSON.parse(await readBody(req)).action;
  } catch {}
  if (action === 'on' || action === 'off') {
    const changed = run.capture !== (action === 'on');
    run.capture = action === 'on';
    // Prompts typed while paused are invisible, so later tool calls must not inherit an older prompt.
    if (action === 'off') run.sessionPrompt.clear();
    return sendJson(res, 200, { ok: true, action, capture: action, changed });
  }
  if (action === 'stop') {
    const file = exportPath(run.runId);
    const exported = buildExport();
    writeJsonAtomic(file, exported);
    res.on('finish', shutdown);
    return sendJson(res, 200, { ok: true, action, run_id: run.runId, file: path.relative(process.cwd(), file), summary: exported.summary });
  }
  sendJson(res, 400, { error: 'action must be one of: on, off, stop' });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const hookMatch = url.pathname.match(/^\/hook\/([^/]+)$/);
  try {
    if (req.method === 'POST' && hookMatch) return await handleHook(req, res, decodeURIComponent(hookMatch[1]));
    if (req.method === 'POST' && url.pathname === '/control') return await handleControl(req, res);
    if (req.method === 'GET' && url.pathname === '/events') return handleStream(req, res);
    if (req.method === 'GET' && url.pathname === '/events.json') return sendJson(res, 200, run.events.map(publicEvent));
    if (req.method === 'GET' && url.pathname === '/state') return sendJson(res, 200, stateView());
    if (req.method === 'GET' && url.pathname === '/interpreter') return handleInterpreter(req, res, url);
    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status ?? 500, { error: err.message });
  }
}

// ---------- interpreter (rule-based, local only) ----------

// First match wins, so more specific intents come first ("fix the failing test" -> debugging).
const INTENTS = [
  ['debugging', /\b(fix|bug|error|fail(s|ed|ing)?|broken|crash|exception|traceback|not working|doesn'?t work)\b/i],
  ['testing', /\b(tests?|spec|coverage|jest|vitest|pytest|assert)\b/i],
  ['refactoring', /\b(refactor|clean ?up|simplify|rename|extract|restructure)\b/i],
  ['implementing', /\b(add|implement|build|create|write|support|make)\b/i],
  ['reviewing', /\b(review|verify|double[- ]check|audit|look over)\b/i],
  ['planning', /\b(plan|design|approach|architecture|requirements?|trade-?offs?)\b/i],
  ['understanding', /\b(explain|what|how|why|where|understand|overview|walk me through)\b/i],
  ['git', /\b(commit|push|branch|merge|rebase|pull request)\b/i],
];
const CORRECTION = /^\s*(no\b|nope|actually|instead|wait|stop|undo|revert|that'?s (wrong|not))/i;
const TOOL_KINDS = [
  ['read', /^(Read|Grep|Glob|LS|NotebookRead)$/],
  ['edit', /^(Edit|MultiEdit|Write|NotebookEdit|apply_patch)$/],
  ['run', /^(Bash|shell|exec_command|local_shell)$/],
  ['web', /^(WebFetch|WebSearch)$/],
  ['delegate', /^(Task|Agent)$/],
];

const classify = (text) => INTENTS.find(([, re]) => re.test(text))?.[0] ?? 'other';
const toolKind = (name) => TOOL_KINDS.find(([, re]) => re.test(name ?? ''))?.[0] ?? 'other';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function interpret() {
  const exported = buildExport();
  const sessions = new Map();
  const sessionFor = (e) => {
    const key = scopeKey(e);
    if (!sessions.has(key)) {
      sessions.set(key, {
        agent: e.agent,
        session_id: e.session_id,
        prompts: [],
        intents: {},
        tools: { read: 0, edit: 0, run: 0, web: 0, delegate: 0, other: 0 },
        failed_tools: 0,
        corrections: 0,
      });
    }
    return sessions.get(key);
  };
  const countTools = (s, events) => {
    for (const e of events) {
      if (e.type === 'tool_started') s.tools[toolKind(e.tool.name)]++;
      if (e.type === 'tool_finished' && e.tool.status !== 'succeeded') s.failed_tools++;
    }
  };

  for (const p of exported.prompts) {
    const s = sessionFor(p);
    const intent = classify(p.text);
    const correction = CORRECTION.test(p.text);
    s.intents[intent] = (s.intents[intent] ?? 0) + 1;
    if (correction) s.corrections++;
    countTools(s, p.events);
    s.prompts.push({
      event_id: p.event_id,
      captured_at: p.captured_at,
      intent,
      correction,
      words: p.text.split(/\s+/).filter(Boolean).length,
      text: p.text.length > 140 ? `${p.text.slice(0, 140)}…` : p.text,
      tool_calls: p.events.filter((e) => e.type === 'tool_started').length,
    });
  }
  for (const e of exported.ungrouped_events) countTools(sessionFor(e), [e]);

  return {
    run_id: run.runId,
    generated_at: new Date().toISOString(),
    sessions: [...sessions.values()].map((s) => ({ ...s, read: narrate(s) })),
  };
}

function narrate(s) {
  const lines = [];
  const totalTools = Object.values(s.tools).reduce((a, b) => a + b, 0);
  if (s.prompts.length) {
    const dominant = Object.entries(s.intents).sort((a, b) => b[1] - a[1])[0][0];
    const latest = s.prompts.at(-1).intent;
    lines.push(`${plural(s.prompts.length, 'prompt')}, mostly ${dominant}; currently ${latest}.`);
    const avgWords = s.prompts.reduce((a, p) => a + p.words, 0) / s.prompts.length;
    if (avgWords < 6) lines.push('Prompts are terse; the agent is filling in the details.');
    else if (avgWords > 60) lines.push('Prompts are detailed and specification-like.');
  } else {
    lines.push('No prompts captured; activity started before capture was on.');
  }
  if (totalTools) {
    lines.push(
      `Agent made ${plural(totalTools, 'tool call')}: ${s.tools.read} read, ${s.tools.edit} edit, ${s.tools.run} run` +
        (s.failed_tools ? `, ${s.failed_tools} failed.` : '.'),
    );
  }
  if (s.tools.edit && !s.tools.run) lines.push('Edits made without running anything to verify them.');
  if (s.corrections) lines.push(`Candidate redirected the agent ${plural(s.corrections, 'time')}.`);
  return lines.join(' ');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function handleInterpreter(req, res, url) {
  const view = interpret();
  const wantsHtml = url.searchParams.get('format') === 'html' || (req.headers.accept ?? '').includes('text/html');
  if (!wantsHtml) return sendJson(res, 200, view);
  const sections = view.sessions.map(
    (s) => `<h2>${escapeHtml(s.agent)} · ${escapeHtml(s.session_id)}</h2><p>${escapeHtml(s.read)}</p>
<table><tr><th>Time</th><th>Intent</th><th>Tools</th><th>Prompt</th></tr>${s.prompts
      .map((p) => `<tr><td>${escapeHtml(p.captured_at)}</td><td>${escapeHtml(p.intent)}${p.correction ? ' (redirect)' : ''}</td><td>${p.tool_calls}</td><td>${escapeHtml(p.text)}</td></tr>`)
      .join('')}</table>`,
  );
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Prompt Watcher · ${escapeHtml(view.run_id)}</title>
<style>body{font:14px system-ui;margin:2rem;max-width:960px}td,th{border-bottom:1px solid #ddd;padding:4px 8px;text-align:left;vertical-align:top}table{border-collapse:collapse;width:100%}</style>
<h1>Run ${escapeHtml(view.run_id)} (capture ${run.capture ? 'on' : 'off'})</h1>${sections.join('') || '<p>No activity yet.</p>'}`);
}

// ---------- server lifecycle ----------

function removeServerFile() {
  if (readJson(SERVER_FILE)?.pid === process.pid) fs.rmSync(SERVER_FILE, { force: true });
}

function shutdown() {
  for (const client of run.clients) client.end();
  removeServerFile();
  server.close(() => process.exit(0));
  server.closeAllConnections();
}

async function isServerAlive(info) {
  try {
    await fetch(`http://127.0.0.1:${info.port}/state`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function start(flags) {
  const existing = readJson(SERVER_FILE);
  if (existing && (await isServerAlive(existing))) fail(`Prompt Watcher is already running on port ${existing.port} (run ${existing.run_id}).`);
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(SERVER_FILE), { recursive: true });

  const runId = flags['run-id'] ?? findUnfinishedRun() ?? newRunId();
  if (!RUN_ID_PATTERN.test(runId)) fail(`Invalid run id "${runId}": use letters, digits, ".", "_" or "-".`);
  if (fs.existsSync(exportPath(runId))) fail(`Run ${runId} already finished (${path.relative(process.cwd(), exportPath(runId))} exists).`);
  run = createRun(runId);
  const recovered = loadLog();

  server = http.createServer(handle);
  const port = Number(flags.port ?? process.env.WATCHER_PORT ?? 0); // 0 = any free port
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
  const actualPort = server.address().port;
  writeJsonAtomic(SERVER_FILE, { pid: process.pid, port: actualPort, run_id: runId, started_at: run.startedAt });

  // Keep idle SSE connections from being closed by proxies/clients.
  setInterval(() => run.clients.forEach((c) => c.write(': ping\n\n')), 15000).unref();
  // Ctrl-C leaves the run unfinished on purpose; the next `start` recovers it.
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => (removeServerFile(), process.exit(130)));

  console.log(
    `Prompt Watcher listening on http://127.0.0.1:${actualPort}\n` +
      `run ${runId} (${recovered ? `recovered, ${plural(run.events.length, 'event')}` : 'new'}), capture off`,
  );
}

async function callServer(method, pathname, body) {
  const info = readJson(SERVER_FILE);
  if (!info) fail('Prompt Watcher is not running. Start it with: node watcher.mjs start');
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${info.port}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    fail(`No watcher responding on port ${info.port} (it may have crashed). Run: node watcher.mjs start`);
  }
  console.log(JSON.stringify(await res.json(), null, 2));
  if (!res.ok) process.exitCode = 1;
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'start':
    await start(parseFlags(args));
    break;
  case 'on':
  case 'off':
  case 'stop':
    await callServer('POST', '/control', { action: command });
    break;
  case 'status':
    await callServer('GET', '/state');
    break;
  default:
    fail('Usage: node watcher.mjs <start [--run-id ID] [--port N] | on | off | stop | status>');
}
