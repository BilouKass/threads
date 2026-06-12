/* API key management page (admin). Auth = session cookie. */
let lastCreated = "";

const $ = (id) => document.getElementById(id);

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (opts.body) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    toast("Erreur: " + (data.error || res.status));
    throw new Error(data.error || res.status);
  }
  return data;
}

async function loadKeys() {
  const { keys } = await api("/api/keys");
  const tbody = document.querySelector("#keysTable tbody");
  if (!keys.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">Aucune clé.</td></tr>';
    return;
  }
  const fmtDate = (d) => (d ? new Date(d).toLocaleString() : "—");
  tbody.innerHTML = keys
    .map((k) => {
      const active = !k.revokedAt;
      const state = active
        ? '<span class="pill ok">active</span>'
        : '<span class="pill mut">révoquée</span>';
      const action = active
        ? `<button class="sm danger" onclick="revokeKey('${k.id}','${(k.name || "").replace(/'/g, "")}')">Révoquer</button>`
        : "";
      return `<tr>
        <td>${k.name || "—"}</td>
        <td><code>${k.prefix}</code></td>
        <td class="mut">${fmtDate(k.createdAt)}</td>
        <td class="mut">${fmtDate(k.lastUsedAt)}</td>
        <td>${state}</td>
        <td style="text-align:right">${action}</td>
      </tr>`;
    })
    .join("");
}

async function createKey() {
  const name = $("newName").value.trim();
  if (!name) return toast("Donne un nom à la clé");
  const res = await api("/api/keys", { method: "POST", body: { name } });
  lastCreated = res.key;
  $("revealKey").textContent = res.key;
  $("reveal").style.display = "block";
  $("newName").value = "";
  loadKeys();
}

function copyKey() {
  navigator.clipboard.writeText(lastCreated).then(
    () => toast("Clé copiée"),
    () => toast("Copie impossible — sélectionne manuellement")
  );
}

async function revokeKey(id, name) {
  if (!confirm(`Révoquer la clé "${name}" ? Les clients qui l'utilisent perdront l'accès.`)) return;
  await api(`/api/keys/${id}`, { method: "DELETE" });
  toast("Clé révoquée");
  loadKeys();
}

(window.AUTH_READY || Promise.resolve()).then((me) => {
  if (me !== null) loadKeys();
});
