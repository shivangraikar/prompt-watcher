# Manual test plan

Run everything from the workspace root. The test uses a fixed port (`--port 4545`) and run id (`manual-1`) so the commands stay short. If `runs/manual-1.json` already exists from an earlier attempt, use a new id (`manual-2`, …) everywhere.

> **Heads-up:** the Claude Code hooks in `.claude/settings.json` are live. While capture is on, any Claude Code session in this workspace (including the one you're chatting with) adds its own events. That changes the counts in Part 1. Either don't chat with Claude Code during Part 1, or expect extra `claude-code` events.

Terminals:
- **A** runs the server
- **B** runs commands
- **C** watches the live stream
- **Browser** shows the interpreter at <http://127.0.0.1:4545/interpreter?format=html>. The page refreshes every 5 s.

---

## Part 1: lifecycle, capture, grouping, crash recovery

### 1. Start the server (A)
```sh
node watcher.mjs start --run-id manual-1 --port 4545
```
Expect:
```
Prompt Watcher listening on http://127.0.0.1:4545
run manual-1 (new), capture off
```
The terminal stays open. `.watcher/server.json` and an empty `runs/manual-1.events.jsonl` now exist.

### 2. Open the live stream (C)
```sh
curl -N localhost:4545/events
```
Expect `: connected`, then nothing. The connection stays open and prints events as they arrive.

Open the interpreter in the browser. Expect: **Run manual-1 (capture off)** and *No activity yet.*

### 3. Status (B)
```sh
node watcher.mjs status
```
Expect `"capture": "off"`, `"events": 0`, and `"stream_clients": 1` (that's terminal C).

### 4. Events are dropped while capture is off (B)
```sh
curl -s -XPOST localhost:4545/hook/codex --data-binary @fixtures/events.ndjson
```
Expect `{"captured": false}`. Nothing appears in C.

### 5. Turn capture on, twice (B)
```sh
node watcher.mjs on
node watcher.mjs on
```
Expect `"capture": "on", "changed": true` the first time and `"changed": false` the second time (idempotent).

### 6. Send the fixture: dedup and invalid lines (B)
```sh
curl -s -XPOST localhost:4545/hook/codex --data-binary @fixtures/events.ndjson
```
Expect `"recorded": 3, "duplicates": 1, "invalid": 1`.

C prints `evt-1`, `evt-2` and `evt-3`:
- `evt-1` and `evt-3` are both "Add a greeting.", from codex/alpha. They count as distinct prompts because they have different source ids.
- `evt-2` comes from `claude-code`/beta. Its `agent` is taken from the payload, not the URL.

### 7. Send it again: everything is a duplicate (B)
```sh
curl -s -XPOST localhost:4545/hook/codex --data-binary @fixtures/events.ndjson
```
Expect `"recorded": 0, "duplicates": 4, "invalid": 1`. Nothing new appears in C.

### 8. Native Claude Code payloads: a prompt and its tool call (B)
```sh
curl -s -XPOST localhost:4545/hook/claude-code -d '{"session_id":"manual","prompt_id":"p1","hook_event_name":"UserPromptSubmit","prompt":"Run the tests"}'
curl -s -XPOST localhost:4545/hook/claude-code -d '{"session_id":"manual","prompt_id":"p1","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm test"},"tool_use_id":"t1"}'
curl -s -XPOST localhost:4545/hook/claude-code -d '{"session_id":"manual","prompt_id":"p1","hook_event_name":"PostToolUse","tool_name":"Bash","tool_response":{"stdout":"ok"},"tool_use_id":"t1"}'
```
Expect `"recorded": 1` for each command. In C:
- `evt-4` is a `user_message`.
- `evt-5` is a `tool_started` and `evt-6` is a `tool_finished` with `"status":"succeeded"`.
- Both `evt-5` and `evt-6` have `"prompt_id":"evt-4"`.

### 9. A tool result whose prompt was never captured (B)
```sh
curl -s -XPOST localhost:4545/hook/claude-code -d '{"session_id":"manual","prompt_id":"p0","hook_event_name":"PostToolUse","tool_name":"Read","tool_response":{},"tool_use_id":"t99"}'
```
Expect `"recorded": 1`. C shows `evt-7` with `"prompt_id":null`, so it ends up in `ungrouped_events` later.

### 10. Bad requests (B)
```sh
curl -s -XPOST localhost:4545/hook/cursor -d '{}'
curl -s -XPOST localhost:4545/control -d '{"action":"jump"}'
```
Expect a 404 `unknown agent "cursor"` that lists `["claude-code","codex"]`, then a 400 `action must be one of: on, off, stop`.

### 11. Pause capture, twice, then send an event (B)
```sh
node watcher.mjs off
node watcher.mjs off
curl -s -XPOST localhost:4545/hook/claude-code -d '{"session_id":"manual","prompt_id":"p2","hook_event_name":"UserPromptSubmit","prompt":"this one is lost"}'
curl -s localhost:4545/events.json
```
Expect:
- `off` reports `"changed": true` the first time and `"changed": false` the second time.
- The hook returns `{"captured": false}`.
- `/events.json` still returns all 7 earlier events, in order. Pausing keeps them readable.

### 12. Starting a second server is refused (B)
```sh
node watcher.mjs start --port 4545
```
Expect `Prompt Watcher is already running on port 4545 (run manual-1).` and exit code 1.

### 13. Resume in the same run (B)
```sh
node watcher.mjs on
curl -s -XPOST localhost:4545/hook/claude-code -d '{"session_id":"manual","prompt_id":"p3","hook_event_name":"UserPromptSubmit","prompt":"Now fix the failing test"}'
node watcher.mjs status
```
Expect:
- C shows `evt-8`. Numbering continues in the same run, and the "lost" prompt from step 11 never appears.
- Status shows `"events": 8, "coding_agents": 2, "agent_sessions": 3, "prompts": 5, "ungrouped_events": 1`.

In the browser, expect three sessions:
- **codex · alpha**: 2 prompts, implementing
- **claude-code · beta**: 1 prompt, testing
- **claude-code · manual**: 2 prompts, currently *debugging*, with 1 tool call (1 run)

### 14. Crash (B)
```sh
kill -9 $(node -p "require('./.watcher/server.json').pid")
node watcher.mjs status
```
Expect:
- Terminal A shows `Killed`, and the curl in C exits.
- Status prints `No watcher responding on port 4545 (it may have crashed). Run: node watcher.mjs start` and exits with code 1.

### 15. Recover (A)
```sh
node watcher.mjs start --port 4545
```
No `--run-id` is needed: it finds the unfinished run. Expect:
```
Prompt Watcher listening on http://127.0.0.1:4545
run manual-1 (recovered, 8 events), capture off
```
Capture is **off** after recovery, as with any `start`.

### 16. The stream replays after recovery (C)
```sh
curl -N localhost:4545/events
```
Expect all 8 events (`evt-1` … `evt-8`) replayed immediately, then the connection stays open.

To check resuming from a point, run `curl -N -H 'Last-Event-ID: evt-7' localhost:4545/events`. Expect only `evt-8`.

### 17. Capture again after recovery (B)
```sh
node watcher.mjs on
curl -s -XPOST localhost:4545/hook/claude-code -d '{"session_id":"manual","prompt_id":"p4","hook_event_name":"UserPromptSubmit","prompt":"after the crash"}'
```
Expect C to show `evt-9`.

### 18. Stop (B)
```sh
node watcher.mjs stop
```
Expect `"ok": true`, `"file": "runs/manual-1.json"`, and the summary `{"coding_agents": 2, "agent_sessions": 3, "prompts": 6}`. Terminal A returns to the prompt, C's curl exits, and `.watcher/server.json` is gone.

### 19. Check the export
```sh
cat runs/manual-1.json
```
Expect:
- **`prompts`**, in this order: `evt-1`, `evt-2`, `evt-3`, `evt-4`, `evt-8`, `evt-9`.
  - Only `evt-4` has events: `evt-5` (tool_started) and `evt-6` (tool_finished). They share `"call_id": "t1"`.
  - The fixture prompts keep their original time as `source_timestamp`.
- **`ungrouped_events`**: just `evt-7`, with `agent` and `session_id`.
- **`summary`**: `{"coding_agents": 2, "agent_sessions": 3, "prompts": 6}`.

### 20. After stop (B)
```sh
node watcher.mjs status
node watcher.mjs on
node watcher.mjs start --run-id manual-1 --port 4545
```
Expect:
- `status` and `on` both print `Prompt Watcher is not running…` and exit with code 1.
- The `start` prints `Run manual-1 already finished (runs/manual-1.json exists).`

---

## Part 2: live Claude Code session

### 1. Start, open the stream, turn capture on
```sh
node watcher.mjs start --port 4545          # A: prints run run-2026…Z (new)
curl -N localhost:4545/events               # C
node watcher.mjs on                         # B
```
Open the interpreter in the browser.

### 2. Use Claude Code in this workspace
In a Claude Code session in this workspace, send a prompt that uses tools, for example *"Read README.md and summarize the requirements"*.

Expect in C:
- A `user_message` with your text and a real UUID `session_id`.
- Then `tool_started` / `tool_finished` pairs, such as `Read`, all with `prompt_id` set to that message's `evt-N`.

The browser shows the session within 5 s, with the prompt's intent and the read/edit/run counts.

A session that was already open before step 1 also works, because Claude Code reloads hook settings live. Only prompts sent after `on` are grouped. Tool calls from a prompt sent before `on` land in `ungrouped_events`.

### 3. Pause mid-session
- Run `node watcher.mjs off`, then send Claude another prompt. Expect nothing in C.
- Run `node watcher.mjs on` and send one more prompt. Expect new events again.
- Tool calls from the prompt sent while paused are not attributed to an older prompt.

### 4. Ctrl-C instead of stop
- Press Ctrl-C in A, then run `node watcher.mjs start --port 4545` again.
- Expect `(recovered, N events)`, the same run id, and capture off.

### 5. Finish
- Run `node watcher.mjs stop`.
- The file `runs/run-2026…Z.json` contains your real prompts with their tool calls grouped underneath.
