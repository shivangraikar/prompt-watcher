# Prompt Watcher

## Problem Statement

Litmus looks at how candidates work with coding agents by interpreting their prompts alongside the agent’s actions. That depends on reliably turning messages, tool calls, and tool results into a stream of events.

Build a local watcher that captures activity from any coding agent active on the machine where the watcher runs. Make the events available live over HTTP and save one JSON record of each server run.

## Requirements

Use `watcher.mjs` as the CLI entry point. Run `node watcher.mjs start` in one terminal and leave it running. From a second terminal in the same workspace, run the other commands to control that server. The CLI must pass those requests to the running server. How it does that is up to you.

- `node watcher.mjs start` launches the local HTTP server with capture off. It recovers an unfinished run if one exists. Otherwise, it begins a new run.
- `node watcher.mjs on` enables capture for any coding agent active on that machine, including sessions that are already open and sessions started later. Running `on` again leaves capture enabled.
- `node watcher.mjs off` pauses capture for all agents on that machine. The server stays up and earlier events stay readable. Running `off` again leaves capture paused. The next `on` resumes capture in the same server run, picking up with new activity from that point forward.
- `node watcher.mjs stop` writes one JSON file for the run to `runs/<run_id>.json` and shuts down the server.

- While capture is on, use coding-agent hooks to collect prompts, tool calls, and results. Normalize events and label them with the agent and session they came from.
- Stream events live over local HTTP, including when sessions overlap. Attach the prompt ID to tool events when the prompt was captured.
- In the JSON export, group tool events under the prompt that triggered them. Keep events whose prompt wasn’t captured in `ungrouped_events`, with their agent and session IDs. Preserve capture order and remove duplicate events. Distinct prompts with identical text should both appear.
- Include a `summary` in the JSON export with the number of distinct coding agents, the number of distinct agent sessions (identified by agent and session ID together), and the number of captured prompts. Count only recorded activity and deduplicate before counting.
- If the watcher crashes, preserve recorded events and recover the unfinished run on the next `start`.

## Expected JSON Output

Each run file contains one list of prompts in capture order. Each prompt identifies its agent and session and contains the activity it triggered. In this example, a prompt from another session arrives while the first prompt’s shell command is still running. The tool call and its result share a `call_id`.

```json
{
  "run_id": "run-1",
  "prompts": [
    {
      "agent": "codex",
      "session_id": "session-1",
      "event_id": "evt-1",
      "captured_at": "2026-11-12T17:00:00Z",
      "type": "user_message",
      "text": "Run the tests.",
      "events": [
        {
          "event_id": "evt-2",
          "captured_at": "2026-11-12T17:00:02Z",
          "type": "tool_started",
          "tool": {
            "call_id": "call-1",
            "name": "Bash",
            "input": {
              "command": "npm test"
            }
          }
        },
        {
          "event_id": "evt-3",
          "captured_at": "2026-11-12T17:00:04Z",
          "type": "tool_finished",
          "tool": {
            "call_id": "call-1",
            "name": "Bash",
            "status": "succeeded"
          }
        }
      ]
    },
    {
      "agent": "claude-code",
      "session_id": "session-2",
      "event_id": "evt-4",
      "captured_at": "2026-11-12T17:00:03Z",
      "type": "user_message",
      "text": "Explain how this project is organized.",
      "events": []
    }
  ],
  "summary": {
    "coding_agents": 2,
    "agent_sessions": 2,
    "prompts": 2
  }
}
```


**Extra credit:** Add an interpreter that uses the prompts to track what the candidate is doing and shows its read of the session on the local HTTP server.
