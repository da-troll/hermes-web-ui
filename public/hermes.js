const $ = (id) => document.getElementById(id);

const state = {
  agents: [],
  selectedAgent: null,
  sessions: [],
  selectedSession: null
};

const statusEl = $("status");
function setStatus(kind, text) {
  statusEl.textContent = text;
  statusEl.className = "status status--" + kind;
}

async function call(path, opts = {}) {
  // Relative URLs so we work at :3473 in local dev AND under /<slug>/ at mvp.trollefsen.com.
  const url = path.startsWith("/") ? "." + path : path;
  const r = await fetch(url, opts);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

function fmtTs(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function fmtNumber(n) {
  if (!n) return "0";
  if (n < 1000) return n.toString();
  if (n < 1e6) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
}

function escape(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function loadAgents() {
  setStatus("busy", "loading agents");
  try {
    const { agents } = await call("/api/agents");
    state.agents = agents;
    renderAgents();
    setStatus("ok", "ready");
  } catch (e) { setStatus("err", e.message); }
}

function renderAgents() {
  const el = $("agentGrid");
  if (!state.agents.length) { el.innerHTML = '<div class="empty">no agents</div>'; return; }
  el.innerHTML = state.agents.map((a) => {
    const selected = state.selectedAgent === a.id ? "selected" : "";
    return `
      <div class="agent-card ${selected}" data-agent="${a.id}">
        <img class="agent-card__avatar" src="${a.avatarUrl}" alt="${escape(a.name)}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'agent-card__avatar',textContent:'${a.emoji}'}))">
        <div class="agent-card__body">
          <div class="agent-card__name">${a.emoji} ${escape(a.name)}</div>
          <div class="agent-card__tag">${escape(a.tagline)}</div>
        </div>
        <div class="agent-card__meta">
          <div class="agent-card__tokens">${fmtNumber(a.tokensToday)}</div>
          <div>${fmtTs(a.lastActivityAt)}</div>
          <div>${a.sessionCount} sess</div>
        </div>
      </div>
    `;
  }).join("");
  el.querySelectorAll(".agent-card").forEach((c) => {
    c.addEventListener("click", () => selectAgent(c.dataset.agent));
  });
}

async function selectAgent(id) {
  state.selectedAgent = id;
  state.selectedSession = null;
  renderAgents();
  $("agentLabel").textContent = "— " + (state.agents.find((a) => a.id === id)?.name || id);
  $("sessionList").innerHTML = '<div class="empty">loading…</div>';
  $("transcript").innerHTML = '<div class="empty">pick a session on the left</div>';
  $("transcriptLabel").textContent = "no session selected";
  try {
    const [{ sessions }, usage] = await Promise.all([
      call(`/api/agents/${id}/sessions`),
      call(`/api/agents/${id}/usage?days=7`)
    ]);
    state.sessions = sessions;
    renderSessions();
    renderSparkline(usage.series);
  } catch (e) {
    setStatus("err", e.message);
    $("sessionList").innerHTML = `<div class="empty">error: ${escape(e.message)}</div>`;
  }
}

function renderSessions() {
  const el = $("sessionList");
  if (!state.sessions.length) { el.innerHTML = '<div class="empty">no sessions</div>'; return; }
  el.innerHTML = state.sessions.map((s) => {
    const selected = state.selectedSession === s.sessionId ? "selected" : "";
    return `
      <div class="session-row ${selected}" data-sid="${s.sessionId}">
        <div class="session-row__key">${escape(s.key)}</div>
        <div class="session-row__meta">${fmtTs(s.lastActivityAt)} · ~${s.turnCount} turns</div>
      </div>
    `;
  }).join("");
  el.querySelectorAll(".session-row").forEach((r) => {
    r.addEventListener("click", () => selectSession(r.dataset.sid));
  });
}

async function selectSession(sessionId) {
  state.selectedSession = sessionId;
  renderSessions();
  const agent = state.selectedAgent;
  $("transcriptLabel").textContent = `${agent} / ${sessionId.slice(0, 8)}…`;
  $("transcript").innerHTML = '<div class="empty">loading transcript…</div>';
  try {
    const { turns } = await call(`/api/sessions/${agent}/${sessionId}?limit=200`);
    renderTranscript(turns);
  } catch (e) {
    $("transcript").innerHTML = `<div class="empty">error: ${escape(e.message)}</div>`;
  }
}

function renderTranscript(turns) {
  const el = $("transcript");
  if (!turns.length) { el.innerHTML = '<div class="empty">(empty session)</div>'; return; }
  el.innerHTML = turns.map((t) => {
    const tokenStr = t.role === "assistant" && t.tokensOut
      ? `<span class="turn__tokens">↑${fmtNumber(t.tokensIn)} ↓${fmtNumber(t.tokensOut)}${t.model ? " · " + escape(t.model) : ""}</span>`
      : "";
    return `
      <div class="turn turn--${t.role}">
        <div class="turn__head">
          <span class="turn__role">${t.role}</span>
          <span class="turn__ts">${fmtTs(t.ts)}</span>
          ${tokenStr}
        </div>
        <div class="turn__text">${escape(t.text || "(empty)")}</div>
      </div>
    `;
  }).join("");
  el.scrollTop = el.scrollHeight;
}

function renderSparkline(series) {
  const el = $("sparkline");
  if (!series || !series.length) { el.innerHTML = '<div class="empty">no data</div>'; return; }
  const max = Math.max(1, ...series.map((d) => d.inputTokens + d.outputTokens));
  const W = 240, H = 48, PAD = 2;
  const bw = (W - PAD * 2) / series.length;
  const bars = series.map((d, i) => {
    const total = d.inputTokens + d.outputTokens;
    const h = Math.max(1, ((total / max) * (H - 14)) | 0);
    const x = PAD + i * bw;
    const y = H - h - 12;
    return `<rect x="${x + 1}" y="${y}" width="${bw - 2}" height="${h}" fill="#4aa3ff" rx="1"></rect>
            <text x="${x + bw / 2}" y="${H - 2}" text-anchor="middle" font-size="8" fill="#6b7a90" font-family="JetBrains Mono, monospace">${d.day.slice(5)}</text>`;
  }).join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg>`;
}

// -------- search --------
let searchTimer = null;
$("search").addEventListener("input", (ev) => {
  const q = ev.target.value.trim();
  clearTimeout(searchTimer);
  if (q.length < 2) { $("searchResults").hidden = true; return; }
  searchTimer = setTimeout(() => runSearch(q), 300);
});

document.addEventListener("click", (ev) => {
  if (!ev.target.closest("#searchResults") && ev.target.id !== "search") {
    $("searchResults").hidden = true;
  }
});

async function runSearch(q) {
  setStatus("busy", "searching");
  try {
    const { hits } = await call(`/api/search?q=${encodeURIComponent(q)}&limit=30`);
    const el = $("searchResults");
    if (!hits.length) {
      el.innerHTML = '<div class="empty">no hits</div>';
    } else {
      el.innerHTML = hits.map((h) => `
        <div class="search-hit" data-agent="${h.agent}" data-sid="${h.sessionId}">
          <div class="search-hit__meta">${h.agent} · ${h.sessionId.slice(0, 8)}… · ${fmtTs(h.ts)}</div>
          <div class="search-hit__preview">${escape(h.preview)}</div>
        </div>
      `).join("");
      el.querySelectorAll(".search-hit").forEach((row) => {
        row.addEventListener("click", async () => {
          await selectAgent(row.dataset.agent);
          await selectSession(row.dataset.sid);
          $("searchResults").hidden = true;
          $("search").value = "";
        });
      });
    }
    el.hidden = false;
    setStatus("ok", `${hits.length} hits`);
  } catch (e) {
    setStatus("err", e.message);
  }
}

$("btnRefresh").addEventListener("click", () => {
  if (state.selectedAgent && state.selectedSession) {
    selectSession(state.selectedSession);
  } else if (state.selectedAgent) {
    selectAgent(state.selectedAgent);
  } else {
    loadAgents();
  }
});

loadAgents();
