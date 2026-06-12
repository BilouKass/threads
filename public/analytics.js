/* Analytics dashboard: follower growth, engagement, top posts. Auth = cookie. */
let accountId = null;
let period = 30;

const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

function fmt(n) {
  if (n === null || n === undefined) return "—";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

// ---- charts (dependency-free SVG) ----
function lineChart(points, color = "#5b8cff") {
  const vals = points.map((p) => p.value).filter((v) => v != null);
  if (vals.length < 2) return '<div class="empty">Pas assez de points (il faut ≥ 2 jours de captures).</div>';
  const w = 900, h = 220, pad = 30;
  const max = Math.max(...vals), min = Math.min(...vals);
  const range = max - min || 1;
  const n = points.length;
  const x = (i) => pad + (i / (n - 1)) * (w - 2 * pad);
  const y = (v) => h - pad - ((v - min) / range) * (h - 2 * pad);
  let d = "";
  points.forEach((p, i) => {
    if (p.value == null) return;
    d += (d ? " L" : "M") + `${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`;
  });
  const area = d + ` L${x(n - 1).toFixed(1)} ${h - pad} L${x(0).toFixed(1)} ${h - pad} Z`;
  const labels = [points[0], points[Math.floor(n / 2)], points[n - 1]]
    .map((p, k) => `<text x="${x(k === 0 ? 0 : k === 1 ? Math.floor(n / 2) : n - 1)}" y="${h - 8}" fill="#8b95a7" font-size="11" text-anchor="middle">${p.day}</text>`)
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}">
    <path d="${area}" fill="${color}22" />
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" />
    <text x="${pad}" y="16" fill="#8b95a7" font-size="11">max ${fmt(max)}</text>
    ${labels}
  </svg>`;
}

function barChart(points, color = "#3fb37f") {
  const vals = points.map((p) => p.value ?? 0);
  if (!vals.length) return '<div class="empty">—</div>';
  const w = 900, h = 200, pad = 26;
  const max = Math.max(...vals, 1);
  const n = points.length;
  const bw = (w - 2 * pad) / n;
  const bars = points
    .map((p, i) => {
      const bh = ((p.value ?? 0) / max) * (h - 2 * pad);
      const x = pad + i * bw;
      const y = h - pad - bh;
      return `<rect x="${(x + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(bw - 2, 1).toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}" rx="2" />`;
    })
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}">${bars}
    <text x="${pad}" y="14" fill="#8b95a7" font-size="11">max ${fmt(max)}</text></svg>`;
}

// ---- data ----
async function loadAccounts() {
  const { accounts } = await api("/api/accounts");
  const sel = $("account");
  sel.innerHTML = accounts.map((a) => `<option value="${a.id}">@${a.username || a.threadsUserId}</option>`).join("");
  if (accounts.length) {
    accountId = accountId || accounts[0].id;
    sel.value = accountId;
  }
  sel.onchange = () => { accountId = sel.value; load(); };
  return accounts.length;
}

function setPeriod(d) {
  period = d;
  document.querySelectorAll(".period button").forEach((b) => b.classList.toggle("active", Number(b.dataset.d) === d));
  load();
}

async function load() {
  if (!accountId) return;
  const a = await api(`/api/accounts/${accountId}/analytics?days=${period}`);
  const s = a.summary;

  const growthCls = s.followersGrowth > 0 ? "up" : s.followersGrowth < 0 ? "down" : "";
  const growthTxt = s.followersGrowth == null ? "" : `<span class="${growthCls}">${s.followersGrowth >= 0 ? "+" : ""}${fmt(s.followersGrowth)}</span> sur ${s.days}j`;
  $("tiles").innerHTML = [
    [`${fmt(s.followersEnd)}`, "Abonnés", growthTxt],
    [`${fmt(s.totalViews)}`, "Vues (cumul)", ""],
    [`${fmt(s.totalLikes)}`, "J'aime (cumul)", ""],
    [`${fmt(s.totalReplies)}`, "Réponses (cumul)", ""],
    [`${fmt(s.totalReposts)}`, "Reposts (cumul)", ""],
  ]
    .map(([v, l, d]) => `<div class="tile"><div class="v">${v}</div><div class="l">${l}</div><div class="d">${d}</div></div>`)
    .join("");

  $("followersChart").innerHTML = lineChart(a.series.map((p) => ({ day: p.day, value: p.followers })));
  $("viewsChart").innerHTML = barChart(a.series.map((p) => ({ day: p.day, value: p.views })));

  const { posts } = await api(`/api/accounts/${accountId}/posts-insights`);
  const tbody = document.querySelector("#postsTable tbody");
  tbody.innerHTML = posts.length
    ? posts
        .map(
          (p) => `<tr>
            <td>${p.postedAt ? new Date(p.postedAt).toLocaleDateString() : "—"}</td>
            <td>${fmt(p.views)}</td><td>${fmt(p.likes)}</td><td>${fmt(p.replies)}</td><td>${fmt(p.reposts)}</td>
            <td>${p.permalink ? `<a href="${p.permalink}" target="_blank">↗</a>` : "—"}</td>
          </tr>`
        )
        .join("")
    : '<tr><td colspan="6" class="empty">Aucune donnée de post encore capturée.</td></tr>';
}

async function capture() {
  if (!accountId) return;
  try {
    await api(`/api/accounts/${accountId}/analytics/capture`, { method: "POST" });
    await load();
  } catch (e) {
    alert("Capture: " + e.message);
  }
}

async function init() {
  try {
    const n = await loadAccounts();
    if (n) await load();
  } catch (e) {
    $("tiles").innerHTML = `<div class="empty">Erreur: ${e.message}</div>`;
  }
}

(window.AUTH_READY || Promise.resolve()).then((me) => {
  if (me !== null) init();
});
