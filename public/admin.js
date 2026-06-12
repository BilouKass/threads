/* Admin dashboard: accounts overview + per-account stats panels. Auth = cookie. */
let accounts = [];
let selectedId = null;
let period = 30;

const $ = (id) => document.getElementById(id);

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

// ---- formatting helpers ----
function fmt(n) {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}
function initials(name, username) {
  const s = (username || name || "?").replace(/^@/, "");
  return s.slice(0, 2).toUpperCase();
}
function avatar(url, name, username, cls = "") {
  if (url) return `<div class="avatar ${cls}"><img src="${url}" alt="" referrerpolicy="no-referrer"/></div>`;
  return `<div class="avatar ${cls}">${initials(name, username)}</div>`;
}
function tokenBadge(expiresAt) {
  if (!expiresAt) return '<span class="pill mut">—</span>';
  const days = Math.round((new Date(expiresAt) - Date.now()) / 86400000);
  if (days < 0) return '<span class="pill err">expiré</span>';
  if (days < 10) return `<span class="pill warn">${days}j</span>`;
  return `<span class="pill ok">${days}j</span>`;
}

// ---- overview ----
async function loadOverview() {
  const o = await api("/api/stats/overview");
  $("overview").innerHTML = [
    ["Comptes", o.accounts],
    ["Comptes actifs", o.activeAccounts],
    ["Posts publiés", o.published],
    ["En attente", o.pending],
    ["Échecs", o.failed],
  ]
    .map(([l, v]) => `<div class="ov-tile"><div class="v">${fmt(v)}</div><div class="l">${l}</div></div>`)
    .join("");
}

// ---- accounts list ----
async function loadAccounts() {
  const { accounts: list } = await api("/api/accounts");
  accounts = list;
  const el = $("acctList");
  if (!accounts.length) {
    el.innerHTML = '<div class="empty">Aucun compte connecté.</div>';
    return;
  }
  el.innerHTML = accounts
    .map(
      (a) => `
      <div class="acct ${a.id === selectedId ? "active" : ""}" onclick="selectAccount('${a.id}')">
        ${avatar(null, a.name, a.username)}
        <div class="meta">
          <div class="u">@${a.username || a.threadsUserId}</div>
          <div class="sub">${a.disabled ? '<span class="err">désactivé</span> · ' : ""}token ${tokenBadge(a.expiresAt)}</div>
        </div>
      </div>`
    )
    .join("");
}

function selectAccount(id) {
  selectedId = id;
  loadAccounts();
  loadPanel();
}

function setPeriod(d) {
  period = d;
  loadPanel();
}

// ---- sparkline ----
function sparkline(series) {
  const vals = (series || []).map((p) => p.value);
  if (vals.length < 2) return '<div class="mut" style="font-size:12px">Pas assez de données pour le graphique.</div>';
  const w = 600, h = 54, max = Math.max(...vals, 1), min = Math.min(...vals);
  const range = max - min || 1;
  const pts = vals
    .map((v, i) => {
      const x = (i / (vals.length - 1)) * w;
      const y = h - 4 - ((v - min) / range) * (h - 8);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline fill="none" stroke="#5b8cff" stroke-width="2" points="${pts}" />
  </svg>`;
}

// ---- panel ----
async function loadPanel() {
  if (!selectedId) return;
  const p = $("panel");
  p.innerHTML = '<div class="empty">Chargement…</div>';
  let s;
  try {
    s = await api(`/api/accounts/${selectedId}/stats?days=${period}`);
  } catch (e) {
    p.innerHTML = `<div class="empty err">Erreur: ${e.message}</div>`;
    return;
  }

  const eng = s.engagement || {};
  const app = s.app || {};
  const notice = s.insightsError
    ? `<div class="notice">⚠️ Statistiques Threads indisponibles : ${s.insightsError}.<br/>
       Le compte doit être (re)connecté avec le scope <code>threads_manage_insights</code> pour afficher abonnés &amp; engagement.</div>`
    : "";

  p.innerHTML = `
    <div class="panel-head">
      ${avatar(s.profilePictureUrl, s.name, s.username)}
      <div>
        <h2>@${s.username || s.accountId}</h2>
        <div class="bio">${s.name ? s.name + " · " : ""}${s.biography ? escapeHtml(s.biography) : ""}</div>
      </div>
      <div class="period">
        ${[7, 30, 90].map((d) => `<button class="sm ${d === period ? "active" : ""}" onclick="setPeriod(${d})">${d}j</button>`).join("")}
      </div>
    </div>

    ${notice}

    <div class="tiles">
      <div class="tile big"><div class="v">${fmt(s.followers)}</div><div class="l">Abonnés</div></div>
      <div class="tile"><div class="v">${fmt(s.recentThreadsCount)}${s.recentThreadsCount === 100 ? "+" : ""}</div><div class="l">Posts récents (Threads)</div></div>
      <div class="tile"><div class="v">${fmt(app.published)}</div><div class="l">Publiés via l'app</div></div>
      <div class="tile"><div class="v">${fmt(app.repliesDone)}</div><div class="l">Réponses envoyées</div></div>
    </div>

    <div class="section-title">Engagement · ${s.periodDays} derniers jours</div>
    <div class="tiles">
      <div class="tile"><div class="v">${fmt(eng.views)}</div><div class="l">Vues</div></div>
      <div class="tile"><div class="v">${fmt(eng.likes)}</div><div class="l">J'aime</div></div>
      <div class="tile"><div class="v">${fmt(eng.replies)}</div><div class="l">Réponses</div></div>
      <div class="tile"><div class="v">${fmt(eng.reposts)}</div><div class="l">Reposts</div></div>
      <div class="tile"><div class="v">${fmt(eng.quotes)}</div><div class="l">Citations</div></div>
    </div>

    <div class="section-title">Vues par jour</div>
    ${sparkline(s.viewsSeries)}

    <div class="section-title">Files de l'app</div>
    <div class="tiles">
      <div class="tile"><div class="v">${fmt(app.pending)}</div><div class="l">En attente</div></div>
      <div class="tile"><div class="v">${fmt(app.processing)}</div><div class="l">En cours</div></div>
      <div class="tile"><div class="v err">${fmt(app.failed)}</div><div class="l">Échecs</div></div>
      <div class="tile"><div class="v">${fmt(app.actionsDone)}</div><div class="l">Actions exécutées</div></div>
    </div>

    <div class="section-title">Derniers posts publiés</div>
    ${
      s.recentPosts && s.recentPosts.length
        ? `<table><thead><tr><th>Date</th><th>Type</th><th>Texte</th><th>Lien</th></tr></thead><tbody>
            ${s.recentPosts
              .map(
                (r) => `<tr>
                  <td>${new Date(r.updatedAt).toLocaleString()}</td>
                  <td>${r.mediaType}</td>
                  <td>${escapeHtml((r.text || "").slice(0, 60))}</td>
                  <td>${r.publishedId ? `<a href="https://www.threads.net/t/${r.publishedId}" target="_blank">ouvrir ↗</a>` : "—"}</td>
                </tr>`
              )
              .join("")}
          </tbody></table>`
        : '<div class="mut" style="font-size:13px">Aucun post publié via l\'app.</div>'
    }
  `;
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function init() {
  try {
    await Promise.all([loadOverview(), loadAccounts()]);
    if (!selectedId && accounts.length) selectAccount(accounts[0].id);
  } catch (e) {
    $("overview").innerHTML = `<div class="empty err">Erreur: ${e.message}</div>`;
  }
}

(window.AUTH_READY || Promise.resolve()).then((me) => {
  if (me !== null) init();
});
