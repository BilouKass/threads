/* Minimal vanilla front-end for the Threads Manager API. Auth = session cookie. */
function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (opts.body && !(opts.body instanceof FormData)) {
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

function pill(status) {
  return `<span class="pill ${status}">${status}</span>`;
}

async function loadAccounts() {
  const { accounts } = await api("/api/accounts");
  const tbody = document.querySelector("#accountsTable tbody");
  tbody.innerHTML = "";
  const selects = [
    document.getElementById("postAccount"),
    document.getElementById("actAccount"),
    document.getElementById("chainAccount"),
    document.getElementById("slotAccount"),
  ].filter(Boolean);
  selects.forEach((s) => (s.innerHTML = ""));
  for (const a of accounts) {
    const exp = a.expiresAt ? new Date(a.expiresAt).toLocaleDateString() : "—";
    tbody.insertAdjacentHTML(
      "beforeend",
      `<tr>
        <td><b>@${a.username || "?"}</b><div class="mut">${a.name || ""}</div></td>
        <td class="mut">${a.threadsUserId}</td>
        <td>${exp}</td>
        <td>${a.disabled ? '<span class="pill FAILED">disabled</span>' : '<span class="pill PUBLISHED">actif</span>'}</td>
        <td><button onclick="refreshToken('${a.id}')">↻ token</button></td>
      </tr>`
    );
    selects.forEach((s) =>
      s.insertAdjacentHTML("beforeend", `<option value="${a.id}">@${a.username || a.threadsUserId}</option>`)
    );
  }
}

async function refreshToken(id) {
  await api(`/api/accounts/${id}/refresh`, { method: "POST" });
  toast("Token rafraîchi");
  loadAccounts();
}

// Upload files and return ordered media items [{type, url}].
async function uploadMedia(files) {
  const media = [];
  for (const f of files) {
    const fd = new FormData();
    fd.append("file", f);
    const { url, type } = await api("/api/uploads", { method: "POST", body: fd });
    media.push({ type, url });
  }
  return media;
}

// Parse ||spoiler|| markers: returns cleaned text + spoiler ranges (offset/length
// computed on the FINAL text, after markers are removed).
function parseSpoilers(raw) {
  const spoilers = [];
  let out = "";
  let i = 0;
  const re = /\|\|([\s\S]*?)\|\|/g;
  let m;
  let last = 0;
  while ((m = re.exec(raw))) {
    out += raw.slice(last, m.index);
    const offset = out.length;
    out += m[1];
    spoilers.push({ offset, length: m[1].length });
    last = m.index + m[0].length;
  }
  out += raw.slice(last);
  return { text: out, spoilers };
}

function collectPoll() {
  const a = document.getElementById("pollA").value.trim();
  const b = document.getElementById("pollB").value.trim();
  const c = document.getElementById("pollC").value.trim();
  const d = document.getElementById("pollD").value.trim();
  if (!a || !b) return null;
  const poll = { optionA: a, optionB: b };
  if (c) poll.optionC = c;
  if (d) poll.optionD = d;
  return poll;
}

async function submitPost(toQueue = false) {
  const accountId = document.getElementById("postAccount").value;
  const rawText = document.getElementById("postText").value;
  const when = document.getElementById("postWhen").value;
  const replyTo = document.getElementById("postReplyTo").value.trim();
  const files = document.getElementById("postImages").files;
  const spoilerMedia = document.getElementById("postSpoilerMedia").checked;
  const poll = collectPoll();

  if (!accountId) return toast("Sélectionnez un compte");

  let media = [];
  if (files.length) {
    if (poll) return toast("Un sondage n'est possible que sur un post texte (sans média)");
    toast("Upload des médias...");
    media = await uploadMedia(files);
  }

  const { text, spoilers } = parseSpoilers(rawText);
  const body = { accountId, text: text || undefined };
  if (media.length) body.media = media;
  if (spoilers.length) body.spoilers = spoilers;
  if (spoilerMedia && media.length) body.isSpoilerMedia = true;
  if (poll) body.poll = poll;

  if (toQueue) {
    // Queue endpoint auto-assigns the next free slot (ignores date/replyTo).
    await api(`/api/accounts/${accountId}/queue`, { method: "POST", body });
    toast("Ajouté à la file d'attente ✅");
  } else {
    if (when) body.scheduledAt = new Date(when).toISOString();
    if (replyTo) body.replyToId = replyTo;
    await api("/api/posts", { method: "POST", body });
    toast("Post planifié ✅");
  }
  document.getElementById("postText").value = "";
  document.getElementById("postImages").value = "";
  document.getElementById("postSpoilerMedia").checked = false;
  ["pollA", "pollB", "pollC", "pollD"].forEach((id) => (document.getElementById(id).value = ""));
  loadPosts();
}

async function submitChain() {
  const accountId = document.getElementById("chainAccount").value;
  const raw = document.getElementById("chainText").value;
  const when = document.getElementById("chainWhen").value;
  if (!accountId) return toast("Sélectionnez un compte");
  const posts = raw
    .split(/\n\s*\n/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const { text, spoilers } = parseSpoilers(t);
      return spoilers.length ? { text, spoilers } : { text };
    });
  if (!posts.length) return toast("Aucun post dans l'enchaînement");

  const body = { accountId, posts };
  if (when) body.scheduledAt = new Date(when).toISOString();
  await api("/api/posts/chain", { method: "POST", body });
  toast(`Enchaînement de ${posts.length} posts créé ✅`);
  document.getElementById("chainText").value = "";
  loadPosts();
}

// ---- Queue slots ----
const DAYS = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];

async function loadSlots() {
  const accountId = document.getElementById("slotAccount").value;
  if (!accountId) return;
  const { slots } = await api(`/api/accounts/${accountId}/slots`);
  const tbody = document.querySelector("#slotsTable tbody");
  tbody.innerHTML = slots.length
    ? slots
        .map(
          (s) => `<tr>
            <td>${DAYS[s.dayOfWeek]} ${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}</td>
            <td style="text-align:right"><button onclick="deleteSlot('${s.id}')">✕</button></td>
          </tr>`
        )
        .join("")
    : '<tr><td class="mut">Aucun créneau. Ajoute-en pour activer la file d\'attente.</td></tr>';
}

async function addSlot() {
  const accountId = document.getElementById("slotAccount").value;
  if (!accountId) return toast("Sélectionnez un compte");
  const dayOfWeek = Number(document.getElementById("slotDay").value);
  const [hour, minute] = document.getElementById("slotTime").value.split(":").map(Number);
  await api(`/api/accounts/${accountId}/slots`, { method: "POST", body: { dayOfWeek, hour, minute } });
  toast("Créneau ajouté");
  loadSlots();
}

async function deleteSlot(id) {
  await api(`/api/slots/${id}`, { method: "DELETE" });
  loadSlots();
}

async function submitAction() {
  const accountId = document.getElementById("actAccount").value;
  const targetId = document.getElementById("actTarget").value.trim();
  const text = document.getElementById("actText").value;
  if (!accountId || !targetId) return toast("Compte et cible requis");
  if (!text.trim()) return toast("Texte de la réponse requis");

  await api("/api/actions", { method: "POST", body: { accountId, type: "REPLY", targetId, text } });
  toast("Réponse envoyée");
  document.getElementById("actText").value = "";
  loadActions();
}

async function loadPosts() {
  const { posts } = await api("/api/posts");
  const tbody = document.querySelector("#postsTable tbody");
  tbody.innerHTML = "";
  for (const p of posts) {
    tbody.insertAdjacentHTML(
      "beforeend",
      `<tr>
        <td>${new Date(p.scheduledAt).toLocaleString()}</td>
        <td>${p.mediaType}</td>
        <td>${(p.text || "").slice(0, 60)}</td>
        <td>${pill(p.status)}</td>
        <td class="mut">${p.lastError || ""}</td>
        <td>${p.status === "PENDING" ? `<button onclick="cancelPost('${p.id}')">✕</button>` : ""}</td>
      </tr>`
    );
  }
}

async function cancelPost(id) {
  await api(`/api/posts/${id}/cancel`, { method: "POST" });
  loadPosts();
}

async function loadActions() {
  const { actions } = await api("/api/actions");
  const tbody = document.querySelector("#actionsTable tbody");
  tbody.innerHTML = "";
  for (const a of actions) {
    tbody.insertAdjacentHTML(
      "beforeend",
      `<tr>
        <td>${new Date(a.scheduledAt).toLocaleString()}</td>
        <td>${a.type}</td>
        <td class="mut">${a.targetId}</td>
        <td>${pill(a.status)}</td>
        <td class="mut">${a.lastError || ""}</td>
      </tr>`
    );
  }
}

function refreshAll() {
  loadAccounts()
    .then(() => loadSlots().catch(() => {}))
    .catch(() => {});
  loadPosts().catch(() => {});
  loadActions().catch(() => {});
}

(window.AUTH_READY || Promise.resolve()).then((me) => {
  if (me === null) return; // not authenticated (redirecting to login)
  refreshAll();
  setInterval(refreshAll, 20000);
});
