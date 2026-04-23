# Agent Hermes — Household Session Inspector

Read-only dashboard for the five Claude Code agents in the Tollefsen household: **Eve, Wilson, Pepper, Radar, C-3PO**. Live agent grid, per-session transcript viewer, 7-day token-usage sparkline, and cross-agent ripgrep search — all fed from real data on disk.

**Live:** https://mvp.trollefsen.com/2026-04-23-hermes-web-ui/ (private — ClawDash auth)
**Inspired by:** [EKKOLearnAI/hermes-web-ui](https://github.com/EKKOLearnAI/hermes-web-ui)

The upstream project is a Vue 3 + Naive UI dashboard for managing AI agent sessions across Telegram / Slack / Discord / WhatsApp. We don't have per-channel agent sessions — we have **five Claude Code agents**, each with a canonical main session plus dozens of ephemeral web / cron / heartbeat sessions bridged through ClawDash. The "multi-channel" framing maps naturally onto "multi-agent, multi-session," so that's what Hermes is for us.

## Data sources (no mocking)

| What | Where |
|------|-------|
| Agent roster | `~/config/household.json` |
| Session registry | `~/.claude/bridge-session-map.json` |
| Transcripts | `~/.claude/projects/<ws>/<sessionId>.jsonl` |
| Token usage | `r.message.usage.input_tokens/output_tokens/cache_*` |
| Avatars | `clawdash.trollefsen.com/media/agents/<id>.png` |

## Features

- **Agent grid** — 5 cards with avatar, tagline, today's token total, last activity, session count.
- **Session rail** — every key in `bridge-session-map.json` for the selected agent (main, `web-*`, heartbeat, cron), sorted by recency.
- **Transcript viewer** — tails the last 200 turns of the selected session's JSONL; folds tool calls; shows per-turn input/output tokens + model.
- **7-day sparkline** — inline SVG bar chart of per-day input+output tokens.
- **Cross-agent search** — `grep -F` over all agent transcript dirs, JSON-parsed hit previews with agent / session / timestamp, click to jump.
- **Read-only** — no session control, no write paths.

## Tech

- Node.js 22 + Express (no build step)
- Vanilla JS client, ~450 lines total
- pm2 on auto-allocated port, deployed via `mvp-finalize.sh`
- 5-second in-memory cache for the agent grid to keep refreshes cheap

## Local dev

```bash
npm install
PORT=3473 node server.js
```

Open http://localhost:3473.

## Notes

- Large JSONL files (Wilson's main is >100MB) are never slurped — the server tails the last N bytes by chunked reverse-reads.
- The bridge uses the historical id `main` for Eve's main session; `BRIDGE_TO_HOUSEHOLD` in `server.js` maps that back to `eve`.
- Cross-agent search uses `grep -Frh -m 20 --include=*.jsonl`; no ripgrep dependency.
