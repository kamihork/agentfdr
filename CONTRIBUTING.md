# Contributing

Thanks for helping build the flight recorder. Two areas benefit most from outside contributions:

## 1. Detector heuristics (`src/detect.js`)

Each detector is a pure function `model -> flags[]`. If you've watched an agent fail in a way the current battery misses, encode it:

- Keep it simple and explainable — a flag must answer "where should I look first?", not render a verdict
- `severity: 'critical'` for "the agent was definitely wasting work", `'warning'` for "worth a look"
- Add a test in `test/` with a synthetic transcript that triggers it and one that must NOT trigger it (false positives are worse than misses)

## 2. Agent adapters (`src/parser.js`)

The normalized model (turns / tool calls / usage / meta events) is deliberately agent-agnostic. To support another agent (Codex CLI, Gemini CLI, OpenHands, Aider...), write a parser from its session log format to the same model shape. Open an issue first so we can agree on where its fields map.

Parser rules that keep the recorder trustworthy:

- **Never throw on unknown input.** Unknown line types become meta events; malformed lines are counted in `totals.parseErrors` and skipped
- **Never accumulate what the source repeats.** Check whether the format duplicates data across lines (Claude Code repeats `usage` per content-block line) before summing anything
- **Prefer official surfaces** (hooks, OTel) where they exist, but don't require them

## Ground rules

- Node ≥18, standard library only — a `package.json` with a new runtime dependency needs a very good reason
- `node --test test/` must pass
- Everything must work fully offline; no network calls from the core

## Releasing (maintainers)

`npm publish` from a clean tree. The package ships `bin/` and `src/` only.
