import express from "express";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "3473", 10);
const HOME = process.env.HOME || "/home/eve";
const HOUSEHOLD = path.join(HOME, "config/household.json");
const BRIDGE_MAP = path.join(HOME, ".claude/bridge-session-map.json");
const PROJECTS_DIR = path.join(HOME, ".claude/projects");

// The bridge uses "main" as the agent id for Eve's main session (historical).
// Map bridge agent ids → household agent ids so roster + transcripts line up.
const BRIDGE_TO_HOUSEHOLD = { main: "eve" };

const AGENT_META = {
  eve:    { name: "Eve",    emoji: "🌿", tagline: "Household manager" },
  wilson: { name: "Wilson", emoji: "🏐", tagline: "Builder" },
  pepper: { name: "Pepper", emoji: "🌶️", tagline: "Inbox guardian" },
  radar:  { name: "Radar",  emoji: "📡", tagline: "Signal watcher" },
  c3po:   { name: "C-3PO",  emoji: "🤖", tagline: "Debugger" }
};

const AVATAR = (id) => `https://clawdash.trollefsen.com/media/agents/${id}.png`;

function workspaceFor(agentId) {
  try {
    const cfg = JSON.parse(fs.readFileSync(HOUSEHOLD, "utf8"));
    return cfg.agents?.[agentId]?.workspace || null;
  } catch { return null; }
}

function projectDirFor(agentId) {
  const ws = workspaceFor(agentId);
  if (!ws) return null;
  return path.join(PROJECTS_DIR, ws.replace(/\//g, "-"));
}

function readSessionMap() {
  try { return JSON.parse(fs.readFileSync(BRIDGE_MAP, "utf8")); }
  catch { return {}; }
}

function sessionsForAgent(agentId) {
  const map = readSessionMap();
  const out = [];
  for (const [key, sid] of Object.entries(map)) {
    const m = key.match(/^agent:([^:]+):(.+)$/);
    if (!m) continue;
    const [, bridgeAgent, kind] = m;
    const resolved = BRIDGE_TO_HOUSEHOLD[bridgeAgent] || bridgeAgent;
    if (resolved !== agentId) continue;
    out.push({ key, sessionId: sid, kind });
  }
  return out;
}

function jsonlPath(agentId, sessionId) {
  const dir = projectDirFor(agentId);
  if (!dir) return null;
  return path.join(dir, `${sessionId}.jsonl`);
}

// Read last N lines of a file without slurping. Good enough for ~100MB jsonl.
function tailLines(file, maxLines = 400) {
  if (!fs.existsSync(file)) return [];
  const CHUNK = 64 * 1024;
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, "r");
  let buf = Buffer.alloc(0);
  let pos = size;
  try {
    while (pos > 0 && buf.toString("utf8").split("\n").length <= maxLines + 1) {
      const readSize = Math.min(CHUNK, pos);
      pos -= readSize;
      const chunk = Buffer.alloc(readSize);
      fs.readSync(fd, chunk, 0, readSize, pos);
      buf = Buffer.concat([chunk, buf]);
    }
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n").filter(Boolean);
  return lines.slice(-maxLines);
}

function parseJsonlLines(lines) {
  const out = [];
  for (const l of lines) {
    try { out.push(JSON.parse(l)); } catch { /* skip malformed */ }
  }
  return out;
}

function extractText(msg) {
  if (!msg) return "";
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (typeof p === "string") return p;
        if (p?.type === "text") return p.text || "";
        if (p?.type === "tool_use") return `[tool: ${p.name}]`;
        if (p?.type === "tool_result") return `[tool result]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function turnFromRecord(r) {
  if (r.type === "user") {
    return { ts: r.timestamp, role: "user", text: extractText(r.message), tokensIn: 0, tokensOut: 0 };
  }
  if (r.type === "assistant") {
    const u = r.message?.usage || {};
    return {
      ts: r.timestamp,
      role: "assistant",
      text: extractText(r.message),
      tokensIn: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      tokensOut: u.output_tokens || 0,
      model: r.message?.model
    };
  }
  if (r.type === "queue-operation" && r.operation === "enqueue") {
    return { ts: r.timestamp, role: "user", text: r.content || "", tokensIn: 0, tokensOut: 0, meta: "queued" };
  }
  return null;
}

function sessionLastActivity(agentId, sessionId) {
  const file = jsonlPath(agentId, sessionId);
  if (!file || !fs.existsSync(file)) return { ts: null, turnCount: 0 };
  const lines = tailLines(file, 1);
  const records = parseJsonlLines(lines);
  const ts = records[0]?.timestamp || fs.statSync(file).mtime.toISOString();
  // Rough turn count = line count via stat+wc — avoid for huge files; estimate from size.
  const bytes = fs.statSync(file).size;
  const turnCount = Math.max(1, Math.round(bytes / 2500)); // ~2.5KB/turn average
  return { ts, turnCount };
}

function tokensTodayFor(agentId) {
  const sessions = sessionsForAgent(agentId);
  const today = new Date().toISOString().slice(0, 10);
  let total = 0;
  for (const s of sessions) {
    const file = jsonlPath(agentId, s.sessionId);
    if (!file || !fs.existsSync(file)) continue;
    const lines = tailLines(file, 1500);
    for (const r of parseJsonlLines(lines)) {
      if (r.type !== "assistant") continue;
      if (!r.timestamp?.startsWith(today)) continue;
      const u = r.message?.usage || {};
      total += (u.input_tokens || 0) + (u.output_tokens || 0);
    }
  }
  return total;
}

// ---- cache ----
const CACHE = new Map();
const CACHE_TTL_MS = 5000;
function cached(key, fn) {
  const now = Date.now();
  const hit = CACHE.get(key);
  if (hit && now - hit.t < CACHE_TTL_MS) return hit.v;
  const v = fn();
  CACHE.set(key, { t: now, v });
  return v;
}

// ---- app ----
const app = express();
app.use(express.json());

app.get("/api/agents", (_req, res) => {
  const data = cached("agents", () => {
    return Object.keys(AGENT_META).map((id) => {
      const sessions = sessionsForAgent(id);
      let latest = null;
      for (const s of sessions) {
        const { ts } = sessionLastActivity(id, s.sessionId);
        if (ts && (!latest || ts > latest)) latest = ts;
      }
      return {
        id,
        ...AGENT_META[id],
        avatarUrl: AVATAR(id),
        sessionCount: sessions.length,
        lastActivityAt: latest,
        tokensToday: tokensTodayFor(id)
      };
    });
  });
  res.json({ agents: data });
});

app.get("/api/agents/:id/sessions", (req, res) => {
  const { id } = req.params;
  if (!AGENT_META[id]) return res.status(404).json({ error: "unknown agent" });
  const sessions = sessionsForAgent(id).map((s) => {
    const { ts, turnCount } = sessionLastActivity(id, s.sessionId);
    return { ...s, lastActivityAt: ts, turnCount };
  });
  sessions.sort((a, b) => (b.lastActivityAt || "").localeCompare(a.lastActivityAt || ""));
  res.json({ agent: id, sessions });
});

app.get("/api/sessions/:agent/:sessionId", (req, res) => {
  const { agent, sessionId } = req.params;
  if (!AGENT_META[agent]) return res.status(404).json({ error: "unknown agent" });
  if (!/^[a-f0-9-]{10,}$/i.test(sessionId)) return res.status(400).json({ error: "bad session id" });
  const file = jsonlPath(agent, sessionId);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: "session jsonl not found" });
  const n = Math.min(500, parseInt(req.query.limit, 10) || 200);
  const records = parseJsonlLines(tailLines(file, n * 2));
  const turns = records.map(turnFromRecord).filter(Boolean).slice(-n);
  res.json({ agent, sessionId, turns });
});

app.get("/api/agents/:id/usage", (req, res) => {
  const { id } = req.params;
  if (!AGENT_META[id]) return res.status(404).json({ error: "unknown agent" });
  const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 7));
  const buckets = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    buckets[d] = { day: d, inputTokens: 0, outputTokens: 0, cacheRead: 0 };
  }
  for (const s of sessionsForAgent(id)) {
    const file = jsonlPath(id, s.sessionId);
    if (!file || !fs.existsSync(file)) continue;
    // Heuristic: read up to 8000 lines tail — good enough for 7-day window on active sessions.
    const lines = tailLines(file, 8000);
    for (const r of parseJsonlLines(lines)) {
      if (r.type !== "assistant") continue;
      const day = r.timestamp?.slice(0, 10);
      if (!day || !buckets[day]) continue;
      const u = r.message?.usage || {};
      buckets[day].inputTokens += u.input_tokens || 0;
      buckets[day].outputTokens += u.output_tokens || 0;
      buckets[day].cacheRead += u.cache_read_input_tokens || 0;
    }
  }
  const series = Object.values(buckets).sort((a, b) => a.day.localeCompare(b.day));
  res.json({ agent: id, days, series });
});

app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (q.length < 2) return res.json({ query: q, hits: [] });
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const dirs = Object.keys(AGENT_META).map(projectDirFor).filter(Boolean).filter(fs.existsSync);
  if (dirs.length === 0) return res.json({ query: q, hits: [] });

  // grep -F (fixed-string), -m N per-file, --include to restrict to jsonl, -r recursive.
  // Prints "<path>:<line>" so we parse both sides cheaply. Caps per-file to keep latency low.
  const args = ["-rFh", "-m", "20", "--include=*.jsonl", "-H", "--", q, ...dirs];
  const grep = spawn("grep", args, { stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  let done = false;
  const finish = (payload) => { if (done) return; done = true; res.json(payload); };
  const fail = (msg) => { if (done) return; done = true; res.status(500).json({ error: msg }); };

  grep.stdout.on("data", (d) => { buf += d.toString("utf8"); });
  grep.on("error", (e) => fail("grep failed: " + e.message));
  grep.on("close", () => {
    const agentByDir = {};
    for (const id of Object.keys(AGENT_META)) {
      const d = projectDirFor(id);
      if (d) agentByDir[d] = id;
    }
    const hits = [];
    for (const line of buf.split("\n")) {
      if (hits.length >= limit) break;
      if (!line) continue;
      // grep -H output: "path:content". jsonl content always starts with "{", so split on ":{".
      const idx = line.indexOf(":{");
      if (idx === -1) continue;
      const file = line.slice(0, idx);
      const content = line.slice(idx + 1);
      const agent = Object.entries(agentByDir).find(([d]) => file.startsWith(d))?.[1];
      if (!agent) continue;
      const sessionId = path.basename(file, ".jsonl");
      let ts = null, preview = content.slice(0, 240);
      try {
        const obj = JSON.parse(content);
        ts = obj.timestamp || null;
        const t = extractText(obj.message) || obj.content || "";
        preview = (t || content).slice(0, 240);
      } catch { /* keep raw preview */ }
      hits.push({ agent, sessionId, ts, preview });
    }
    finish({ query: q, hits });
  });
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`hermes-web-ui listening on :${PORT}`);
});
