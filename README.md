# agentfdr

**Flight data recorder for local coding agents.**
When Claude Code loops, drifts off-goal, or quietly burns two million tokens, `agentfdr` shows you *why* — turn by turn, after the fact.

```
npx agentfdr
```

That's the whole setup. Your sessions are already recorded — Claude Code writes a full transcript of every session to `~/.claude/projects/`. `agentfdr` reads those transcripts and turns them into something a human can investigate: a timeline of every turn's tool calls, token consumption, context growth, and stop decisions, with known failure patterns flagged automatically.

**Zero instrumentation. Zero cloud. Zero config.** Nothing is sent anywhere; the viewer binds to `127.0.0.1` and reads files you already have.

## Why

Autonomous agent failures are hard to debug because the evidence is gone by the time you notice:

- *The loop* — edit → test fails → same edit, for 40 minutes
- *The drift* — you asked for a bugfix, it refactored the router
- *The burn* — a huge tool result crowds the context, cache stops hitting, every turn re-reads 200k tokens
- *The bad landing* — "Done!" with failing tests, or no stop at all

Existing LLM observability tools (LangSmith, Langfuse, AgentOps) assume **you instrument your own app with their SDK and send traces to their cloud**. A prebuilt local agent like Claude Code offers no instrumentation point — but it doesn't need one. The data is already on disk. What's missing is the crash investigator's toolkit. This is that toolkit.

## Commands

```
agentfdr                    # open the newest session's timeline in your browser
agentfdr list               # all recorded sessions across all projects
agentfdr open 35cb18        # open a session by id prefix (or path to a .jsonl)
agentfdr blame 35cb18       # markdown autopsy — paste it into an issue
agentfdr stats              # token totals per project
```

## What you get

**Timeline** — one screen for the whole session, per turn:
- *Tools lane*: every tool call as a colored block, errors ringed in red
- *Context lane*: stacked context-window composition (cache read / cache write / fresh input) — watch it grow, watch compaction reset it
- *Output lane*: output tokens per turn
- Markers for user prompts and compaction events; hover any turn for the full readout, click for the dissection: usage breakdown, assistant text, every tool call with duration, result size, and result snippet

**Anomaly flags** — heuristics that answer "where do I look first?":

| Flag | Meaning |
|---|---|
| `loop` | The same tool-call sequence repeated 3+ times consecutively |
| `error-streak` | 3+ consecutive tool calls failed |
| `context-bloat` | A single tool result ≥50k chars landed in context |
| `token-spike` | Context jumped >60% (+50k) in one turn |
| `cache-thrash` | Consecutive turns paying full price, zero cache hits |
| `file-churn` | The same file edited 6+ times |

**Blame report** — `agentfdr blame` renders the same analysis as markdown, ready for an issue or a Slack thread.

## How it works

Claude Code appends every event of a session — user prompts, assistant messages with full token usage, tool calls, tool results, compaction, mode changes — to a JSONL transcript under `~/.claude/projects/<project>/<session-id>.jsonl`. `agentfdr` parses that into a normalized turn model and runs the detectors over it. That's it: no daemon, no database, no runtime dependencies (Node ≥18 standard library only).

The transcript format is not a published API, so the parser is written to survive it: unknown line types become meta events, malformed lines are counted and skipped, and schema changes are contained in one adapter module.

## Privacy

Transcripts contain your code, your prompts, and your file paths. Therefore:
- everything runs locally; the server binds to `127.0.0.1` only
- there is no telemetry, no phone-home, no account
- `blame` output goes to stdout — you decide what leaves the machine

## Roadmap

- [ ] Session diff — compare the failed attempt with the successful retry
- [ ] Adapters for other agents (Codex CLI, Gemini CLI, OpenHands, Aider) behind a common event schema
- [ ] Subagent/sidechain tree rendering
- [ ] Watch mode (`agentfdr watch`) with live timeline
- [ ] CI gate — `agentfdr assert --no-loops --max-tokens 2M`
- [ ] Pluggable detector rules (YAML)

The longer-term plan (in Japanese): [docs/事業案.md](docs/事業案.md).

## Development

```
git clone <repo> && cd agentfdr
node --test test/        # run tests
node bin/agentfdr.js     # run the CLI from source
```

`src/ui.html` is served fresh on every request — edit it and reload the browser, no restart needed.

Contributions welcome — especially adapters for other agents and new detector heuristics. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
