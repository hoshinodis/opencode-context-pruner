# opencode-context-pruner

Continuous, verbatim context pruning for [OpenCode](https://opencode.ai), powered by TypeSafe [Jev](https://docs.typesafe.ai/).

Adapted from [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT). Upstream targets Claude Code's `session.compact` hook. OpenCode (tested: `opencode2` 0.0.0-beta-17963) does not implement a compaction hook, so this port prunes the **outgoing model request** from the `context` hook instead: stale tool calls/results are judged per call (keep / truncate / drop) and removed from the request view. Persisted history is never modified, so nothing disappears from your session log.

## Why

Long coding sessions fill up with stale tool output. Instead of an LLM-written summary that paraphrases details away, every kept message stays **verbatim** — only old tool calls/results are dropped or truncated, decided by calibrated Jev judgments.

## How it works

1. `session.hook("context")` runs right before each model dispatch
2. messages are converted to the vendor core's shape; each tool call gets two `noul` questions: keep the call? keep the result?
3. decisions are applied to the request's message view:
   - `drop_call` removes the call and its result
   - `drop_result` keeps the call and truncates the result text with a note
   - `keep` is left untouched
4. decisions are cached per `tool_use_id` inside the session, so each tool call is judged once — requests without new tool calls make **no Jev request at all**
5. fail-open: any error leaves the request untouched

Tool call/result pairing is always preserved (a dropped call takes its result with it).

## Measured (2026-09-19, a real 530-message session)

```
messages: 530
judged:   257 calls (7 batches, fitted state 24,974 tokens)
dropped:  257 calls + 257 results, removedMessages: 282
time:     1,135 ms
result:   model replied normally
```

## Requirements

- OpenCode V2 beta **`0.0.0-beta-19271` or newer** (older builds, e.g. `beta-17963`, leak hook message changes into the session view — do not use this plugin there)
- TypeSafe API key: `TYPESAFE_API_KEY` in the environment of the OpenCode server, or `~/.config/opencode/typesafe/api_key`

## Install

```sh
git clone https://github.com/hoshinodis/opencode-context-pruner ~/app/opencode-context-pruner
ln -s ~/app/opencode-context-pruner ~/.config/opencode/plugins/opencode-context-pruner
export TYPESAFE_API_KEY=...
```

## Options

Plugin options can be passed through OpenCode's plugin config; defaults below.

| option | default | meaning |
|---|---|---|
| `enabled` | `true` | `TYPESAFE_COMPACTION=off` also disables |
| `model` | `jev-1.13.0` | pinned Jev model |
| `keepThreshold` | `0.15` | `noul` threshold for keeping a call/result (upstream uses `0.5`; see below) |
| `preserveRecentMessages` | `10` | newest messages are never judged |
| `truncateHeadChars` | `300` | head kept when truncating a result |
| `minResultChars` | `4000` | skip entirely when the request has less tool output |
| `maxStateTokens` / `maxRequestTokens` | `25000` / `30000` | state fitting limits |
| `rejudge` | `never` | `always` re-judges everything on each request |
| `apiKeyEnv` / `apiKeyFile` | `TYPESAFE_API_KEY` / `~/.config/opencode/typesafe/api_key` | key lookup |
| `logFile` | `~/.config/opencode/context-pruner/decisions.jsonl` | JSONL decision log |

### Why `keepThreshold` defaults to 0.15, not 0.5

The two questions Jev answers are "is this call still needed for the assistant's next action?" and "is the full result still needed?". Measured on a realistic transcript, old calls score:

```
keepCall   0.17 – 0.23
keepResult 0.11 – 0.14
```

With upstream's `0.5` (or even `0.3`) every unpinned call is `drop_call`. With `0.15` the common outcome becomes `drop_result`: the call and its input stay, only the bulky result text is truncated. Set `keepThreshold: 0.5` if you want the original aggressive behavior.

## Non-destructive by construction

Decisions are applied to **clones**: input messages and tool parts are never mutated (this is enforced by tests). Only the request view is replaced; persisted history and the UI keep every original message. If the runtime rejects the replacement array, the plugin does nothing (fail-open).

## Caveats

- Decisions are cached per `tool_use_id`: a call judged once keeps that verdict for the rest of the session.
- `keepThreshold: 0.5` (upstream's default) drops nearly every unpinned call in a long session; the `0.15` default exists to keep the call and truncate only its result.
- Jev can be wrong. The decision log keeps every action so you can audit and re-tune.

## Vendored core

`src/vendor/` is a copy of [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) `src/` (MIT, v0.2.0). See `THIRD_PARTY_NOTICES.md`. To update, copy the upstream `src/` again.

## Development

```sh
npm install
npm run typecheck
npm test
```

## License

MIT. Not affiliated with TypeSafe, OpenCode, or the fast-jev-compaction author.
