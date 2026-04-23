# hermes-web-ui — Household Agent Inspector

**Inspired by:** EKKOLearnAI/hermes-web-ui (multi-channel Vue/Naive dashboard for Telegram/Slack/Discord/WhatsApp agent sessions).

**Contextualized for our stack:** we don't have Telegram/Slack/Discord agent channels — we have **five Claude Code agents** (Eve, Wilson, Pepper, Radar, C-3PO), each with a canonical "main" session plus dozens of ephemeral web/cron/heartbeat sessions, all bridged through ClawDash. The "multi-channel" framing maps naturally onto "multi-agent, multi-session."

Rebuild as a read-only **Agent Session Inspector** for the household — one dashboard to see what every agent is doing, what they're spending, and what they said last.

## Goal (scoped, 4h)

A single-page dashboard at `mvp.trollefsen.com/2026-04-23-hermes-web-ui/` that surfaces:

1. **Agent grid** — 5 cards (avatar, name, status, last-activity timestamp, token-today total)
2. **Session list per agent** — all sessions in `bridge-session-map.json` for that agent (main, web-*, heartbeat, cron), sorted by last activity
3. **Transcript viewer** — tail the selected session's JSONL, render user/assistant turns, tool calls collapsed
4. **Token-usage sparkline** — last 7 days of input+output tokens per agent from JSONL usage blocks
5. **Cross-agent search** — grep across all agent transcripts for a string, return hit list (agent / session / timestamp / preview)

Out of scope: session control (kill/resume), replying into sessions, authoring new sessions. Read-only.

## Real data sources (no mocking)

| What | Where |
|------|-------|
| Agent roster | `/home/eve/config/household.json` |
| Session registry | `/home/eve/.claude/bridge-session-map.json` |
| Transcripts | `/home/eve/.claude/projects/-home-eve-workspaces-{agent}/<sessionId>.jsonl` |
| Token usage | `{jsonl}` → `.message.usage.input_tokens` + `.output_tokens` + cache fields |
| Agent avatars | `https://clawdash.trollefsen.com/media/agents/{name}.png` |
| Bridge status | `systemctl --user is-active clawdash-bridge` (optional, read-only) |

## Stack

- Node.js 22 + Express (no build step — matches every other nightly MVP pattern)
- Vanilla JS client, `presentation_v2`-ish brand tokens, purple/ink palette to match Deck Studio
- No DB — filesystem reads on each API call, 5s in-memory cache for agent grid / token totals
- pm2 (auto-port 3460-3499), deployed via `mvp-finalize.sh`

## API

```
GET  /api/agents                           → [{id, name, emoji, avatarUrl, status, lastActivityAt, tokensToday}]
GET  /api/agents/:id/sessions              → [{key, sessionId, kind, lastActivityAt, turnCount}]
GET  /api/sessions/:agent/:sessionId       → [{ts, role, text, toolUse, tokensIn, tokensOut}]  (last N turns)
GET  /api/agents/:id/usage?days=7          → [{day, inputTokens, outputTokens, cacheRead}]
GET  /api/search?q=…&limit=50              → [{agent, sessionId, ts, preview}]
```

## UI layout

```
┌────────────────────────────────────────────────────────────────┐
│ Agent Hermes                          [search across agents… ] │
├─────────────┬──────────────────────────────────────────────────┤
│ [Eve grid ] │  session: agent:wilson:main                       │
│ [Wilson*  ] │  ───────────────────────────────────────────────  │
│ [Pepper   ] │  ❯ you  2026-04-23 22:14  "start hermes build…"  │
│ [Radar    ] │  » wilson …                                       │
│ [C-3PO    ] │  [tool: Read …]                                   │
│             │  …                                                │
│ sparkline   │                                                   │
│ sessions:   │                                                   │
│  · main     │                                                   │
│  · web-xyz  │                                                   │
└─────────────┴──────────────────────────────────────────────────┘
```

## Build order

1. Scaffold `package.json`, `server.js`, `public/` (HTML + CSS + JS), `metadata.json`
2. Implement `/api/agents` + agent grid (the hardest data-shape work up front)
3. Implement `/api/agents/:id/sessions` + session list rail
4. Implement `/api/sessions/:agent/:sessionId` + transcript viewer (read last 200 lines of JSONL, fold tool blocks)
5. Implement `/api/agents/:id/usage` + sparkline (SVG, inline — no chart lib)
6. Implement `/api/search` (ripgrep over JSONL dirs, JSON-parse hits, cap at 50)
7. Brand polish, empty states, error states
8. `mvp-finalize.sh` deploy + Playwright smoke test
9. README + commit

## Risks / trade-offs

- **JSONL files are large** — wilson's main transcript is >100MB. Always read via `tail -n` or line-count + stream; never load whole files.
- **Cross-agent read perms** — all project dirs live under `/home/eve/.claude/projects/`, owned by eve. No sudo needed.
- **Avatar URLs** — hot-linked from `clawdash.trollefsen.com/media/` (already public). Cheap.
- **Bridge status** — skip if fragile. Not core to the MVP.
- **Scope creep** — NO writes, NO replies, NO session control. Pure read dashboard.

## Deploy

Server MVP. `package.json` includes `start`. Finalize with:
```
bash /home/eve/workspaces/shared/scripts/nightly-builder/mvp-finalize.sh 2026-04-23-hermes-web-ui
```
(per `feedback_mvp_finalize.md` — never run raw generate-caddyfile + caddy reload)

Visibility: **private** (ClawDash cookie-auth). This exposes transcript content — no public exposure.
