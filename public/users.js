/* Admin users management. */
let accounts = [];

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

async function load() {
  const [{ users }, accRes] = await Promise.all([api("/api/users"), api("/api/accounts")]);
  accounts = accRes.accounts;
  const tbody = document.querySelector("#usersTable tbody");
  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">Aucun utilisateur.</td></tr>';
    return;
  }
  tbody.innerHTML = users
    .map((u) => {
      const state = u.disabled
        ? '<span class="pill warn">désactivé</span>'
        : '<span class="pill ok">actif</span>';
      const assigned =
        u.role === "ADMIN"
          ? '<span class="mut">tous (admin)</span>'
          : `<div class="assign">${accounts
              .map(
                (a) => `<label><input type="checkbox" ${u.accountIds.includes(a.id) ? "checked" : ""}
                  onchange="toggleAssign('${u.id}','${a.id}',this.checked)"/> @${a.username || a.threadsUserId}</label>`
              )
              .join("")}</div>`;
      return `<tr>
        <td><b>${u.username}</b></td>
        <td>${u.role}</td>
        <td>${state}</td>
        <td>${assigned}</td>
        <td style="white-space:nowrap">
          <button class="sm" onclick="toggleDisabled('${u.id}',${!u.disabled})">${u.disabled ? "Activer" : "Désactiver"}</button>
          <button class="sm" onclick="resetPassword('${u.id}')">Mot de passe</button>
          <button class="sm danger" onclick="removeUser('${u.id}','${u.username}')">Suppr.</button>
        </td>
      </tr>`;
    })
    .join("");
}

async function createUser() {
  const username = document.getElementById("nu").value.trim();
  const password = document.getElementById("np").value;
  const role = document.getElementById("nr").value;
  if (!username || !password) return toast("Identifiant et mot de passe requis");
  await api("/api/users", { method: "POST", body: { username, password, role } });
  toast("Utilisateur créé");
  document.getElementById("nu").value = "";
  document.getElementById("np").value = "";
  load();
}

async function toggleDisabled(id, disabled) {
  await api(`/api/users/${id}`, { method: "PATCH", body: { disabled } });
  load();
}

async function resetPassword(id) {
  const password = prompt("Nouveau mot de passe (min. 6 caractères) :");
  if (!password) return;
  await api(`/api/users/${id}`, { method: "PATCH", body: { password } });
  toast("Mot de passe mis à jour");
}

async function removeUser(id, username) {
  if (!confirm(`Supprimer l'utilisateur "${username}" ?`)) return;
  await api(`/api/users/${id}`, { method: "DELETE" });
  toast("Utilisateur supprimé");
  load();
}

async function toggleAssign(userId, accountId, checked) {
  if (checked) {
    await api(`/api/users/${userId}/accounts`, { method: "POST", body: { accountId } });
  } else {
    await api(`/api/users/${userId}/accounts/${accountId}`, { method: "DELETE" });
  }
}

(window.AUTH_READY || Promise.resolve()).then((me) => {
  if (me) load();
});
