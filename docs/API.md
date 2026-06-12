# Référence API — Threads Manager

Base URL par défaut : `http://localhost:3000` (serveur API/UI). Le serveur **média** signé
écoute en plus sur `:8080` mais `/media` est aussi servi sur l'API (voir §Média).

Toutes les réponses sont en **JSON** (sauf `/media` qui renvoie l'image, et le callback OAuth qui
renvoie du HTML).

## Sommaire
- [Authentification](#authentification)
- [Format des erreurs](#format-des-erreurs)
- [Santé](#santé)
- [Session & login](#session--login)
- [OAuth Threads](#oauth-threads)
- [Comptes](#comptes)
- [Posts](#posts)
- [Upload de médias](#upload-de-médias)
- [Média signé](#média-signé)
- [Actions (réponses)](#actions-réponses)
- [File d'attente & créneaux](#file-dattente--créneaux)
- [Stats](#stats)
- [Analytics](#analytics)
- [Clés API](#clés-api-admin)
- [Utilisateurs](#utilisateurs-admin)
- [Types & contraintes](#types--contraintes)

---

## Authentification

Chaque route `/api/*` accepte **l'un ou l'autre** :

1. **Cookie de session** (`sid`, httpOnly) — pour l'UI web, obtenu via `POST /auth/login`.
2. **Clé API** — pour les machines (n8n, scripts) :
   `X-API-Key: <clé>` **ou** `Authorization: Bearer <clé>`.

Le cookie est essayé en premier ; une **clé API = accès ADMIN** (machine de confiance).

### Rôles & portée

| Principal | Accès |
|---|---|
| **ADMIN** (utilisateur) ou **clé API** | Tout, tous les comptes. |
| **VA** (utilisateur) | Opérations sur ses **comptes assignés** uniquement ; **pas** d'accès aux clés API ni aux utilisateurs. |

- Routes **admin-only** : `/api/keys/*`, `/api/users/*` → `403` sinon.
- Routes **liées à un compte** : un VA non assigné au compte → `403`. Les listes (`/api/accounts`,
  `/api/posts`, `/api/actions`, `/api/stats/overview`) sont **filtrées** aux comptes autorisés.

---

## Format des erreurs

Réponse d'erreur : `{ "error": "message" }` (parfois `issues` pour les erreurs de validation zod).

| Code | Sens |
|---|---|
| `400` | Corps/paramètre invalide (`issues` détaille les champs zod). |
| `401` | Non authentifié (ni session ni clé valide). |
| `403` | Authentifié mais droits insuffisants (admin requis, ou compte non autorisé). |
| `404` | Ressource introuvable. |
| `409` | Conflit (ex. identifiant utilisateur déjà pris). |
| `410` | Lien média expiré. |
| `413` | Fichier trop volumineux. |
| `500` | Erreur serveur (ex. échec d'échange OAuth). |

---

## Santé

### `GET /health`
Public. → `200 { "ok": true, "ts": "2026-06-12T..." }`

---

## Session & login

### `POST /auth/login`
Public. Ouvre une session (pose le cookie `sid`).

Body : `{ "username": "admin", "password": "secret" }`

→ `200 { "user": { "id": "...", "username": "admin", "role": "ADMIN" } }`
(+ en-tête `Set-Cookie: sid=...`) · `401 { "error": "Identifiants invalides" }`

### `POST /auth/logout`
Authentifié. Détruit la session et efface le cookie. → `200 { "ok": true }`

### `GET /auth/me`
Authentifié. Renvoie le principal courant.

→ utilisateur : `{ "type": "user", "id", "username", "role": "ADMIN|VA", "accountIds": [] }`
→ machine : `{ "type": "apikey", "role": "ADMIN" }` · sinon `401`.

---

## OAuth Threads

### `GET /auth/threads`
**Authentifié (session)**. Démarre le flux : crée un `state` (avec l'`userId`) et **redirige** (302)
vers la page d'autorisation Threads.

### `GET /auth/threads/callback?code=...&state=...`
Public (ouvert par le navigateur via la redirection de Meta). Échange le `code`, stocke le compte +
tokens chiffrés, et **auto-assigne** le compte à l'utilisateur initiateur. Renvoie une page **HTML**
de confirmation. Erreurs : `400` (code/state manquant ou invalide), `500` (échec d'échange).

---

## Comptes

Champs d'un compte : `id, threadsUserId, username, name, tokenType, scope, expiresAt, lastRefreshAt, disabled, createdAt`.

### `GET /api/accounts`
Liste les comptes (un VA ne voit que ses comptes assignés).
→ `200 { "accounts": [ { ... } ] }`

### `POST /api/accounts/:id/refresh`
Force le rafraîchissement du token long-lived. → `200 { "ok": true }`

### `PATCH /api/accounts/:id`
Active/désactive. Body : `{ "disabled": true }` → `200 { "ok": true, "disabled": true }`

### `DELETE /api/accounts/:id`
Supprime le compte (cascade : posts, actions, créneaux, analytics, assignations). → `200 { "ok": true }`

---

## Posts

### `POST /api/posts`
Planifie (ou publie immédiatement) **un** post. Accès au `accountId` requis.

Body :
| Champ | Type | Notes |
|---|---|---|
| `accountId` | string | **requis** |
| `text` | string | requis si aucun média et pas de sondage |
| `media` | `{type:"IMAGE"\|"VIDEO", url}[]` | ordonné ; ≤ 20 ; mixte = carrousel |
| `imageUrls` | `string[]` (url) | raccourci → media IMAGE |
| `videoUrls` | `string[]` (url) | raccourci → media VIDEO |
| `poll` | `{optionA, optionB, optionC?, optionD?}` | **texte seul** ; 2-4 options de 1-25 car. |
| `spoilers` | `{offset, length}[]` | ≤ 10 ; plages dans `text` |
| `isSpoilerMedia` | boolean | floute le média |
| `scheduledAt` | string (ISO 8601) | absent ⇒ immédiat |
| `replyToId` | string | publie en réponse à ce media id |
| `linkAttachment` | string (url) | texte seul |
| `maxAttempts` | int 1-10 | défaut 3 |

→ `201 { "post": { ...ScheduledPost } }` · `400` (validation) · `403` · `404`.

Exemple :
```bash
curl -X POST http://localhost:3000/api/posts -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"accountId":"ck...","text":"Hello 👋","scheduledAt":"2026-06-13T09:00:00.000Z"}'
```

### `POST /api/posts/bulk`
Crée plusieurs posts (chaque item = même schéma que `POST /api/posts`).
Body : `{ "posts": [ {…}, {…} ] }` (1 à 200) → `201 { "count": N, "posts": [...] }`

### `POST /api/posts/chain`
Crée un **enchaînement** : le 1ᵉʳ post est publié à `scheduledAt`, chaque suivant en réponse au
précédent (le worker enchaîne automatiquement).

Body :
```json
{
  "accountId": "ck...",
  "scheduledAt": "2026-06-13T09:00:00.000Z",
  "maxAttempts": 3,
  "posts": [ { "text": "1/3 …" }, { "text": "2/3 …" }, { "text": "3/3 …" } ]
}
```
(chaque post accepte aussi `media/imageUrls/videoUrls/poll/spoilers/isSpoilerMedia`, 1 à 50 posts)
→ `201 { "chainId": "chain_...", "count": N, "posts": [...] }`

### `GET /api/posts?accountId=&status=`
Liste (≤ 200, plus récents d'abord). `status` ∈ `PENDING|PROCESSING|PUBLISHED|FAILED|CANCELLED`.
VA : filtré à ses comptes. → `200 { "posts": [...] }`

### `POST /api/posts/:id/cancel`
Annule un post (passe `CANCELLED`). → `200 { "ok": true, "post": {...} }` · `404`.

---

## Upload de médias

### `POST /api/uploads`
Authentifié. **multipart/form-data**, champ `file`. Stocke le fichier en privé et renvoie une URL
signée/expirante. Formats : `jpg, jpeg, png, gif, webp, mp4, mov, webm`. Taille max 200 Mo.

→ `201 { "url": "https://.../media/<rnd>?exp=..&sig=..", "type": "IMAGE|VIDEO", "expiresAt": "..." }`
· `400` (type non supporté) · `413` (trop gros).

```bash
curl -X POST http://localhost:3000/api/uploads -H "X-API-Key: $KEY" -F "file=@photo.jpg"
```

---

## Média signé

### `GET /media/:filename?exp=<ms>&sig=<hmac>`
**Public** (c'est Meta qui télécharge l'image). Vérifie la signature HMAC et l'expiration.
Servi **à la fois** sur l'API (`PORT`) et sur le serveur média (`MEDIA_PORT`).

→ `200` (binaire, `Content-Type` image/vidéo) · `403` (signature invalide) · `410` (expiré) · `404`.

---

## Actions (réponses)

### `POST /api/actions`
Body : `{ "accountId", "type": "REPLY", "targetId", "text", "scheduledAt"?, "maxAttempts"? }`
`targetId` = media id du post/commentaire visé. → `201 { "action": {...} }`

### `POST /api/replies`
Raccourci (type forcé à `REPLY`). Body : `{ "accountId", "targetId", "text", "scheduledAt"? }`
→ `201 { "action": {...} }`

### `GET /api/actions?accountId=&status=`
Liste (≤ 200). VA : filtré. → `200 { "actions": [...] }`

---

## File d'attente & créneaux

Les créneaux (`QueueSlot`) sont interprétés en **heure locale serveur**. `dayOfWeek` : 0=dimanche … 6=samedi.

### `GET /api/accounts/:id/slots`
→ `200 { "slots": [ { "id", "accountId", "dayOfWeek", "hour", "minute" } ] }`

### `POST /api/accounts/:id/slots`
Body : `{ "dayOfWeek": 1, "hour": 9, "minute": 0 }` → `201 { "slot": {...} }`

### `DELETE /api/slots/:slotId`
→ `200 { "ok": true }` · `404`.

### `POST /api/accounts/:id/queue`
Ajoute un post au **prochain créneau libre**. Body : `{ text?, media?, imageUrls?, videoUrls?, poll?, spoilers?, isSpoilerMedia?, maxAttempts? }`
→ `201 { "post": {...}, "scheduledAt": "..." }` · `400` (aucun créneau configuré).

### `GET /api/accounts/:id/queue/next`
Renvoie le prochain créneau libre sans rien planifier. → `200 { "nextSlot": "2026-06-15T07:00:00.000Z" }`

---

## Stats

Stats **instantanées** (appellent l'API Threads au chargement). Requièrent le scope `threads_manage_insights`.

### `GET /api/stats/overview`
Compteurs (filtrés aux comptes du VA le cas échéant).
→ `200 { "accounts", "activeAccounts", "published", "pending", "failed", "actions" }`

### `GET /api/accounts/:id/stats?days=30`
`days` 1-90. → `200` :
```json
{
  "accountId", "username", "name", "profilePictureUrl", "biography",
  "tokenExpiresAt", "disabled", "periodDays",
  "followers": 1234,
  "engagement": { "views", "likes", "replies", "reposts", "quotes" },
  "viewsSeries": [ { "t", "value" } ],
  "recentThreadsCount": 42,
  "app": { "published", "pending", "processing", "failed", "cancelled", "actionsDone", "repliesDone" },
  "recentPosts": [ { "id", "text", "mediaType", "publishedId", "updatedAt" } ],
  "insightsError": null
}
```
`insightsError` non nul si le scope insights manque (reconnecter le compte).

---

## Analytics

Données **historisées** (snapshots quotidiens capturés par le worker toutes les 12 h).

### `GET /api/accounts/:id/analytics?days=30`
`days` 1-365. → `200` :
```json
{
  "series": [ { "day": "2026-06-12", "followers", "views", "likes", "replies", "reposts", "quotes" } ],
  "summary": {
    "days", "points",
    "followersStart", "followersEnd", "followersGrowth",
    "totalViews", "totalLikes", "totalReplies", "totalReposts", "totalQuotes"
  }
}
```
Calculs : `followersGrowth = followersEnd − followersStart` (≥ 2 points) ; `total* = somme des valeurs journalières`.

### `GET /api/accounts/:id/posts-insights`
Insights par post, triés par vues décroissantes.
→ `200 { "posts": [ { "mediaId", "views", "likes", "replies", "reposts", "quotes", "shares", "permalink", "postedAt", "capturedAt" } ] }`

### `POST /api/accounts/:id/analytics/capture`
Déclenche une capture immédiate (snapshot + insights). → `200 { "ok": true }`

---

## Clés API (admin)

Réservé **ADMIN**. La valeur brute n'est renvoyée **qu'à la création**.

### `GET /api/keys`
→ `200 { "keys": [ { "id", "name", "prefix", "lastUsedAt", "revokedAt", "createdAt" } ] }`

### `POST /api/keys`
Body : `{ "name": "n8n" }` → `201 { "id", "prefix", "key": "tk_..." }`

### `DELETE /api/keys/:id`
Révoque (pose `revokedAt`). → `200 { "ok": true }`

---

## Utilisateurs (admin)

Réservé **ADMIN**.

### `GET /api/users`
→ `200 { "users": [ { "id", "username", "role", "disabled", "accountIds": [], "createdAt" } ] }`

### `POST /api/users`
Body : `{ "username" (≥3), "password" (≥6), "role": "ADMIN|VA"? }` (défaut `VA`)
→ `201 { "user": { "id", "username", "role" } }` · `409` (identifiant pris).

### `PATCH /api/users/:id`
Body (champs optionnels) : `{ "role"?, "disabled"?, "password"? (≥6) }` → `200 { "ok": true }`

### `DELETE /api/users/:id`
→ `200 { "ok": true }`

### Assignations de comptes (scoping VA)
- `GET /api/users/:id/accounts` → `200 { "accountIds": [] }`
- `POST /api/users/:id/accounts` — Body : `{ "accountId" }` → `201 { "ok": true }`
- `DELETE /api/users/:id/accounts/:accountId` → `200 { "ok": true }`

---

## Types & contraintes

**ScheduledPost** : `id, accountId, text, mediaType (TEXT|IMAGE|VIDEO|CAROUSEL), media, poll, spoilers,
isSpoilerMedia, replyToId, linkAttachment, chainId, chainOrder, dependsOnPostId, scheduledAt,
status (PENDING|PROCESSING|PUBLISHED|FAILED|CANCELLED), attempts, maxAttempts, lastError, publishedId,
createdAt, updatedAt`.

**Action** : `id, accountId, type (REPLY), targetId, text, scheduledAt, status, attempts, maxAttempts,
lastError, resultId, createdAt, updatedAt`.

**Règles de validation clés** :
- Média : ≤ 20 éléments. 0 ⇒ TEXT, 1 ⇒ IMAGE/VIDEO, ≥ 2 ⇒ CAROUSEL (mixte autorisé).
- Sondage : **post texte uniquement** (refusé avec média) ; 2-4 options de 1-25 caractères.
- Spoilers texte : ≤ 10 ; `offset`/`length` entiers, `offset+length ≤ longueur du texte`.
- `scheduledAt` : ISO 8601. Absent ⇒ exécution au prochain tick du worker.
- Les médias doivent être des **URL publiquement accessibles** par Meta (utiliser `/api/uploads`).

**Cadence worker** : posts/actions à chaque tick (`SCHEDULER_POLL_SECONDS`, défaut 15 s) ; refresh
tokens / 6 h ; nettoyage uploads / 30 min ; analytics / 12 h.

> Voir aussi [`ARCHITECTURE.md`](ARCHITECTURE.md) pour l'architecture, l'auth en détail, la DB et le
> calcul des analytics.
