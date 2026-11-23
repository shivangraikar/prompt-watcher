# Prompt Watcher: running it

Requires Node 18+ (uses built-in `fetch`). No dependencies, no build step.

## Run

```sh
node watcher.mjs start                 # terminal 1: server, capture off; recovers an unfinished run
node watcher.mjs start --run-id test-1 # use a fixed run id (also recovers it if unfinished)
node watcher.mjs start --port 4545     # fixed port (default: any free port)

node watcher.mjs on       # terminal 2: start capturing (idempotent)
node watcher.mjs off      # pause capture; server and earlier events stay (idempotent)
node watcher.mjs status   # run id, capture state, counts
node watcher.mjs stop     # write runs/<run_id>.json and shut down
```

The server listens on `127.0.0.1`. Its port, pid and run id are kept in `.watcher/server.json`, which is how the CLI and the hooks find it.

Files:
- `runs/<run_id>.events.jsonl` is an append-only event log, written before each event is acknowledged. A crash loses nothing, and the next `start` replays it.
- `runs/<run_id>.json` is the final export, written by `stop`. A run that has this file is finished and won't be recovered.

Ctrl-C on `start` exits **without** finishing the run, so the next `start` resumes it.

## HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/hook/:agent` | Raw hook payload (`claude-code` or `codex`). Accepts a single JSON object, a JSON array, or NDJSON. Returns `202 {captured:false}` while capture is off. |
| GET | `/events` | SSE: replays every event in the run, then streams new ones live. Honors `Last-Event-ID`. |
| GET | `/events.json` | Full ordered array of events. |
| GET | `/state` | Run id, capture state, counts. |
| POST | `/control` | `{"action": "on" \| "off" \| "stop"}` |
| GET | `/interpreter` | Rule-based read of each session (JSON; add `?format=html` for a page that auto-refreshes). |

```sh
PORT=$(node -p "require('./.watcher/server.json').port")
curl -N localhost:$PORT/events
curl -s -XPOST localhost:$PORT/hook/codex --data-binary @fixtures/events.ndjson
```

## Installing hooks

Hooks stay installed all the time. The server decides whether to record, so `on`/`off` never edit agent config. If the watcher isn't running, `hook.mjs` exits silently. It never writes to stdout and always exits 0, so it can't block or alter the agent.

### Claude Code (verified)

This is already set up in `.claude/settings.json` at the workspace root, scoped to this project and not the global config. It registers `node "${CLAUDE_PROJECT_DIR}/hook.mjs" claude-code` for `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `PostToolUseFailure`. Claude Code picks up edits to settings files in sessions that are already open.

Scope: only Claude Code sessions opened in this workspace are captured. To capture every project on the machine, put the same `hooks` block in `~/.claude/settings.json` and use an absolute path to `hook.mjs`.

### Codex (unverified)

The `codex` adapter accepts canonical README-shaped events, plus hook payloads that use Claude-style field names (`hook_event_name`, `tool_use_id`, …). Point your Codex hook command at `node /abs/path/to/hook.mjs codex`, or POST events to `/hook/codex` yourself.

### Adding an agent

Add an entry to `ADAPTERS` in `hook.mjs` that maps the raw payload to `{agent, session_id, type, text | tool, source_event_id?, source_timestamp?, source_prompt_id?}`, or returns `null` to ignore it.

## Behavior notes

- **Event ids:** the watcher assigns `evt-N` in capture order. An agent's own id is kept as `source_event_id`, and its timestamp as `source_timestamp`.
- **Dedup key** (first one that applies):
  1. agent + session + the agent's event id
  2. agent + session + type + `call_id` for tool events
  3. the hook's delivery id (retries reuse it)
  4. a hash of the payload

  Prompts with identical text but different ids or deliveries are kept as separate prompts.
- **Grouping a `tool_started` event:**
  - If the agent supplied a prompt id (Claude does), use the captured prompt with that id.
  - Otherwise, use the session's latest captured prompt.
- **Grouping a `tool_finished` event:** it goes under whichever prompt its `call_id` started under. A result for a call whose start wasn't captured goes to `ungrouped_events`.
- **After `off`:** the session's "latest prompt" is cleared. A prompt typed while capture was paused is never attributed to an older one.
- **Size limit:** tool inputs and outputs longer than 4000 characters are truncated.
