# 🧵 Threads Manager

Gestionnaire **multi-comptes** pour l'API Threads (Meta) :

- 🔐 **Connexion OAuth** + stockage **chiffré** des tokens en base, avec **refresh automatique** (tokens longue durée ~60 jours).
- 📅 **Planification de posts** (texte, image unique, carrousel) et **réponses** à des posts/commentaires.
- 🎞️ **Médias riches** : image, **vidéo**, **carrousel mixte** photo+vidéo (jusqu'à 20 éléments).
- 🗳️ **Sondages** (poll, 2-4 options) et 🙈 **spoilers** (texte flouté `||…||` + média flouté).
- 🧵 **Enchaînements** (threads) : une chaîne de posts publiés l'un après l'autre en réponse.
- 🗓️ **File d'attente** : créneaux récurrents par compte + ajout au prochain créneau libre, et **bulk scheduling**.
- 📈 **Analytics historisées** : snapshots quotidiens (croissance abonnés + engagement) et insights par post, avec page **Analytics** (graphiques).
- 👥 **Multi-utilisateurs & rôles** : connexion par identifiant/mot de passe (session), **Admin** (accès total) et **VA** (gère uniquement ses comptes assignés, sans accès aux clés ni aux utilisateurs).
- 📊 **Tableau de bord d'administration** : tous les comptes + un panneau de stats par compte (abonnés, vues, j'aime, réponses, reposts, citations via Threads Insights + files de l'app).
- 🧩 Pilotable via **interface web** OU **API programmatique** (clés API → idéal **n8n**, scripts, cron…).
- 🐳 **Docker Compose** : API + worker (scheduler) + PostgreSQL.

> 📖 **Documentation technique** (architecture, authentification, base de données, calcul des
> analytics) : [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
> 📑 **Référence API complète** (tous les endpoints, corps, réponses, codes) :
> [`docs/API.md`](docs/API.md).

## Architecture

```
                +------------------+
  Web UI  ─────▶|                  |
  n8n     ─────▶|   API (Fastify)  |──┐
  scripts ─────▶|   /api/* + OAuth |  │   écrit les jobs
                +------------------+  ▼
                        │        +------------------+
                        │        |   PostgreSQL     |
                        │        |  comptes, tokens │
                        │        |  posts, actions  │
                        ▼        +------------------+
                +------------------+      ▲
                |  Worker          |──────┘  poll + publie + refresh tokens
                |  (scheduler)     |─────────▶ Threads Graph API
                +------------------+
```

- `src/server.ts` — API HTTP + OAuth + sert l'UI web (`public/`).
- `src/worker.ts` — boucle de planification : publie les posts dus, exécute les actions, rafraîchit les tokens proches de l'expiration.
- Les deux partagent la même base de code et la même base PostgreSQL.

## Démarrage rapide (Docker)

1. **Créer une app Threads** sur <https://developers.facebook.com/> (produit *Threads API*). Récupérer **App ID** et **App secret**, et déclarer l'URI de redirection (ex : `http://localhost:3000/auth/threads/callback`).

2. **Configurer l'environnement** :
   ```bash
   cp .env.example .env
   # éditer .env : THREADS_APP_ID, THREADS_APP_SECRET, THREADS_REDIRECT_URI, PUBLIC_BASE_URL
   # générer la clé de chiffrement :
   openssl rand -hex 32   # -> coller dans TOKEN_ENCRYPTION_KEY
   ```

3. **Lancer** :
   ```bash
   docker compose up --build
   ```
   - API : <http://localhost:3000>
   - Au premier boot, une **clé API master** est générée et affichée **une seule fois** dans les logs du conteneur `api`. Conservez-la.

4. **Connecter un compte** : ouvrir <http://localhost:3000>, coller la clé API, cliquer *« Connecter un compte Threads »* → flux OAuth → le compte et ses tokens sont stockés.

> ⚠️ **OAuth en local** : le `redirect_uri` est ouvert par **ton navigateur** (pas par les serveurs Meta), donc `http://localhost:3000/...` fonctionne pour toi sans rien exposer.

### Exposer l'image — serveur media dédié (IP + port + URL aléatoire)

L'API Threads ne reçoit pas les octets bruts d'une image : elle **télécharge une `image_url`**. On ne stocke donc jamais l'image en accès public permanent. À la place :

1. `POST /api/uploads` enregistre le fichier **en privé** (dossier `uploads/`, hors `public/`).
2. Il renvoie une **URL aléatoire, signée et expirante** : `http://<IP>:<MEDIA_PORT>/media/<aléatoire>?exp=...&sig=<HMAC>` — non devinable, valable `MEDIA_SIGNED_URL_TTL_MINUTES` minutes.
3. Meta télécharge l'image au moment de la publication.
4. **Le fichier est supprimé** dès que le post est publié (+ balayage des orphelins toutes les 30 min).

L'app lance **deux serveurs** :

| Serveur | Port | À exposer sur Internet ? |
|---|---|---|
| Admin API + UI + OAuth | `PORT` (3000) | ❌ peut rester en local |
| **Serveur media** (images) | `MEDIA_PORT` (8080) | ✅ **seul port à ouvrir** |

Configuration (`.env`) :
```env
MEDIA_PORT=8080
MEDIA_PUBLIC_HOST=auto          # auto-détecte ton IP publique au démarrage
# MEDIA_PUBLIC_HOST=203.0.113.42        # ou fixe ton IP publique
# MEDIA_PUBLIC_HOST=media.mondomaine.com  # ou un domaine
# MEDIA_PUBLIC_BASE_URL=https://media.mondomaine.com  # override complet (HTTPS / reverse proxy)
```

Puis **ouvre/forwarde le port** `MEDIA_PORT` sur ton routeur/pare-feu vers la machine. Vérifie depuis l'extérieur : `http://TON_IP:8080/health` doit répondre `{ "ok": true }`.

> ℹ️ L'URL est **aléatoire et signée**, mais elle pointe vers ton IP. Pour des posts **planifiés loin dans le futur**, garde une IP/host stable (IP fixe, DNS dynamique, ou reverse proxy) et augmente `MEDIA_SIGNED_URL_TTL_MINUTES` (le fichier reste jusqu'à publication, puis est supprimé). Pour un post immédiat, aucune contrainte.
>
> 🔒 En exposant un port directement, mets idéalement le serveur media derrière **HTTPS** (reverse proxy : Caddy/Nginx) et renseigne `MEDIA_PUBLIC_BASE_URL`. Seule la route `/media` (signée) est accessible sur ce port.

## Démarrage sans Docker

### Script de lancement (Windows) — recommandé

Vérifie Node, le `.env`, les dépendances, PostgreSQL et le schéma, puis démarre **l'API et le
worker ensemble** (un seul terminal, logs préfixés `[api]` / `[worker]`) :

```powershell
.\start.ps1            # mode DEV (hot-reload)
.\start.ps1 -Prod      # build + version compilée
.\start.ps1 -SkipDb    # sans re-synchroniser le schéma
```

Ou double-clique **`start.bat`** (lance le mode DEV).

### Manuel / multiplateforme

```bash
npm install
cp .env.example .env   # configurer (DATABASE_URL, creds Meta, ADMIN_PASSWORD…)
npm run db:push        # crée/synchronise le schéma (Postgres doit tourner)
npm run dev            # API + worker ensemble (hot-reload)   — ou: npm start (compilé)
```

> `npm run dev` / `npm start` lancent les deux processus via **concurrently**. Pour les séparer :
> `npm run dev:api` + `npm run dev:worker` dans deux terminaux.

## Connexion & utilisateurs

L'**interface web** se connecte par **identifiant + mot de passe** (session cookie).

1. **Créer le 1er admin** : soit définir `ADMIN_USERNAME` / `ADMIN_PASSWORD` dans `.env` (créé au boot), soit `npm run seed:user -- <identifiant> <mot_de_passe> admin`.
2. Aller sur `/login.html`, se connecter.
3. **Gérer les utilisateurs** (page **Utilisateurs**, admin only) : créer des **VA**, leur **assigner des comptes** (un VA ne voit que ses comptes assignés et n'a accès ni aux clés ni aux utilisateurs).

Les **clés API** restent réservées aux **machines** (n8n, scripts) et sont gérées par un admin.

## API HTTP

Auth : chaque appel `/api/*` accepte **un cookie de session** (UI) **ou** l'en-tête
`X-API-Key: <clé>` / `Authorization: Bearer <clé>` (machines). Une clé API a un accès **admin**.
Les routes `/auth/login`, `/auth/threads*` gèrent l'authentification.

| Méthode & route | Description |
|---|---|
| `GET /auth/threads` | Démarre le flux OAuth (redirige vers Threads). |
| `GET /auth/threads/callback` | Callback OAuth : stocke le compte + tokens. |
| `GET /api/accounts` | Liste les comptes connectés. |
| `POST /api/accounts/:id/refresh` | Force le refresh du token. |
| `PATCH /api/accounts/:id` | `{ "disabled": true }` active/désactive. |
| `DELETE /api/accounts/:id` | Supprime le compte. |
| `POST /api/uploads` | Upload image (multipart `file`) → renvoie une `url` signée/temporaire. |
| `GET /media/:file` | Sert l'image via URL signée (fetch par Meta) — public, supprimée après publication. |
| `POST /api/posts` | Planifie/publie un post (texte, image, vidéo, carrousel mixte). |
| `POST /api/posts/bulk` | Crée plusieurs posts en un appel (`{ posts: [...] }`). |
| `POST /api/posts/chain` | Crée un enchaînement (thread) : posts publiés en chaîne. |
| `GET /api/posts` | Liste les posts (`?accountId=&status=`). |
| `POST /api/posts/:id/cancel` | Annule un post en attente. |
| `GET/POST /api/accounts/:id/slots` · `DELETE /api/slots/:id` | Créneaux récurrents (file d'attente). |
| `POST /api/accounts/:id/queue` | Ajoute un post au prochain créneau libre. |
| `GET /api/accounts/:id/analytics?days=30` | Séries temporelles (abonnés, engagement). |
| `GET /api/accounts/:id/posts-insights` | Insights par post (classés par vues). |
| `POST /api/accounts/:id/analytics/capture` | Capture immédiate (sinon toutes les 12h). |
| `POST /api/actions` | Crée une action (`REPLY`). |
| `POST /api/replies` | Raccourci pour une réponse. |
| `GET /api/actions` | Liste les actions. |
| `GET /api/stats/overview` | Totaux globaux (comptes, posts publiés/en attente/échecs). |
| `GET /api/accounts/:id/stats?days=30` | Stats d'un compte : abonnés + engagement (Threads Insights) + files de l'app. |
| `GET /api/keys` · `POST /api/keys` · `DELETE /api/keys/:id` | Gestion des clés API. |

### Planifier un post

```bash
# Post texte immédiat
curl -X POST http://localhost:3000/api/posts \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{ "accountId": "ckxyz...", "text": "Hello Threads 👋" }'

# Post planifié avec image (image_url publique requise)
curl -X POST http://localhost:3000/api/posts \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{
    "accountId": "ckxyz...",
    "text": "Coucher de soleil",
    "imageUrls": ["https://exemple.com/photo.jpg"],
    "scheduledAt": "2026-06-12T18:00:00.000Z"
  }'

# Réponse à un post/commentaire
curl -X POST http://localhost:3000/api/replies \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{ "accountId": "ckxyz...", "targetId": "178...", "text": "Merci !" }'
```

- `imageUrls` : 0 → post texte, 1 → image, 2-20 → carrousel. Type média déduit automatiquement.
- `scheduledAt` : ISO 8601. Absent ⇒ publication immédiate (au prochain tick du worker).
- `replyToId` : transforme le post en réponse.

### Upload d'image puis post

```bash
# 1. Upload -> renvoie une URL signée et temporaire (le fichier est privé)
URL=$(curl -s -X POST http://localhost:3000/api/uploads \
  -H "X-API-Key: $KEY" -F "file=@photo.jpg" | jq -r .url)

# 2. Crée le post avec cette URL ; après publication le fichier est supprimé du serveur
curl -X POST http://localhost:3000/api/posts -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"accountId\":\"ckxyz...\",\"text\":\"Test\",\"imageUrls\":[\"$URL\"]}"
```

> Les images sont stockées en privé puis exposées uniquement via l'URL signée/expirante `/media/...`, et **effacées du serveur une fois le post publié**. Voir [Exposer l'image](#exposer-limage--serveur-media-dédié-ip--port--url-aléatoire).

### Vidéo & carrousel mixte

`POST /api/uploads` renvoie `{ url, type }` (`type` = `IMAGE` ou `VIDEO`). Compose ensuite un post avec un tableau `media` ordonné :

```bash
curl -X POST http://localhost:3000/api/posts -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" -d '{
    "accountId": "ckxyz...",
    "text": "Photo + vidéo dans un même carrousel",
    "media": [
      { "type": "IMAGE", "url": "https://.../media/aaa?exp=..&sig=.." },
      { "type": "VIDEO", "url": "https://.../media/bbb?exp=..&sig=.." }
    ]
  }'
```

0 média → texte · 1 → image ou vidéo · 2-20 → carrousel (mixte autorisé). `imageUrls`/`videoUrls` restent acceptés en raccourci.

### Sondages & spoilers

```bash
# Sondage (post TEXTE uniquement, 2 à 4 options de 1-25 caractères)
curl -X POST http://localhost:3000/api/posts -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" -d '{
    "accountId": "ckxyz...",
    "text": "Votre langage préféré ?",
    "poll": { "optionA": "TypeScript", "optionB": "Python", "optionC": "Go" }
  }'

# Spoiler texte : `spoilers` = plages [offset, length] sur le texte (max 10)
curl -X POST http://localhost:3000/api/posts -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" -d '{
    "accountId": "ckxyz...",
    "text": "Le tueur est le majordome",
    "spoilers": [ { "offset": 14, "length": 11 } ]
  }'

# Spoiler média : floute l'image/vidéo/carrousel
curl -X POST http://localhost:3000/api/posts -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" -d '{
    "accountId": "ckxyz...", "text": "Attention spoiler",
    "imageUrls": ["https://.../media/x?exp=..&sig=.."], "isSpoilerMedia": true
  }'
```

- **Poll** : uniquement sur un post texte (refusé s'il y a un média). Mappé sur `poll_attachment`.
- **Spoiler texte** : `spoilers` → `text_entities` de type `SPOILER`. Dans l'UI web, entoure simplement le passage de `||…||` (les offsets sont calculés automatiquement).
- **Spoiler média** : `isSpoilerMedia: true` → `is_spoiler_media` (IMAGE/VIDEO/CAROUSEL). Combinable avec un spoiler texte.

### Enchaînements (threads)

```bash
curl -X POST http://localhost:3000/api/posts/chain -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" -d '{
    "accountId": "ckxyz...",
    "scheduledAt": "2026-06-12T09:00:00.000Z",
    "posts": [ {"text":"1/3 …"}, {"text":"2/3 …"}, {"text":"3/3 …"} ]
  }'
```

Le 1er post est publié à `scheduledAt`, puis chaque post suivant est publié **en réponse** au précédent (le worker enchaîne automatiquement une fois le prédécesseur publié).

### File d'attente (créneaux récurrents) + bulk

```bash
# 1. Définir des créneaux (dayOfWeek 0=dimanche … 6=samedi, heure locale serveur)
curl -X POST http://localhost:3000/api/accounts/ckxyz.../slots -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" -d '{ "dayOfWeek": 1, "hour": 9, "minute": 0 }'

# 2. Ajouter un post à la file → il prend le prochain créneau libre
curl -X POST http://localhost:3000/api/accounts/ckxyz.../queue -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" -d '{ "text": "Posté au prochain créneau" }'

# 3. Bulk : créer plusieurs posts d'un coup
curl -X POST http://localhost:3000/api/posts/bulk -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" -d '{ "posts": [
    {"accountId":"ckxyz...","text":"A","scheduledAt":"2026-06-12T08:00:00Z"},
    {"accountId":"ckxyz...","text":"B","scheduledAt":"2026-06-12T12:00:00Z"} ]}'
```

### Analytics

Le worker capture **toutes les 12 h** un snapshot par compte (abonnés + engagement) et les insights des posts récents, historisés en base (`metric_snapshots`, `post_insights`). La page **Analytics** trace la croissance des abonnés, les vues/jour et le classement des posts. Endpoints : `GET /api/accounts/:id/analytics?days=30`, `GET /api/accounts/:id/posts-insights`, et `POST /api/accounts/:id/analytics/capture` pour forcer une capture. (Nécessite le scope `threads_manage_insights`.)

## Intégration n8n

L'API étant 100 % HTTP + clé API, n8n la pilote avec le node **HTTP Request** :

1. Créez une clé dédiée : `POST /api/keys` `{ "name": "n8n" }` (ou `npm run seed:apikey -- "n8n"`).
2. Dans n8n → **Credentials → Header Auth** : `Name = X-API-Key`, `Value = <clé>`.
3. Node **HTTP Request** :
   - Method `POST`, URL `https://votre-app/api/posts`
   - Auth : *Header Auth* (la credential ci-dessus)
   - Body (JSON) : `{ "accountId": "...", "text": "{{$json.message}}", "scheduledAt": "{{$json.when}}" }`

Exemples de workflows :
- **RSS → Threads** : node RSS → HTTP Request `POST /api/posts` (publication auto).
- **Réponse auto** : Webhook → HTTP Request `POST /api/replies`.
- **Buffer éditorial** : Google Sheets (ligne = post planifié) → HTTP Request `POST /api/posts`.

> Le contrat HTTP est stable : tout outil capable d'appeler une API REST (Make, Zapier, cron + curl, scripts) fonctionne de la même manière.

## Sécurité

- Tokens d'accès **chiffrés** en base (AES-256-GCM, clé `TOKEN_ENCRYPTION_KEY`). Jamais renvoyés par l'API.
- Clés API stockées **hashées** (SHA-256). La valeur brute n'est montrée qu'à la création.
- Pensez à servir l'app derrière HTTPS en production et à restreindre `@fastify/cors`.

## Limitations

- **Like / repost** : non disponibles. L'API Graph officielle de Threads **n'expose pas** d'endpoint pour liker ou reposter un élément — ces actions ont donc été retirées de l'app (seules les **réponses** sont supportées côté actions). Si Meta publie ces endpoints un jour, il suffira de rajouter le type d'action dans `src/services/actions.ts` (+ l'enum Prisma `ActionType`).
- **Rate limits** Threads : ~250 posts / 24 h et ~1000 réponses / 24 h par compte (selon Meta). Le worker ne fait pas encore de throttling dédié.
- **Vidéos** : le client supporte les conteneurs `VIDEO` (`src/threads/client.ts`) mais l'UI/API publique se concentre sur texte + images.
- **Statistiques (Insights)** : abonnés & engagement utilisent l'API Threads Insights, qui exige le scope **`threads_manage_insights`** (désormais dans les scopes par défaut). Un compte connecté **avant** cet ajout doit être **reconnecté** pour autoriser le scope ; sinon le panneau affiche un avertissement et les compteurs restent `—`. Threads n'expose pas de total exact de posts : on affiche les posts publiés via l'app + un échantillon récent (≤100) du compte.

## Structure du projet

```
src/
  config.ts            # validation env (zod) + chargement .env local
  crypto.ts            # chiffrement tokens + génération clés API
  publicUrl.ts         # résolution IP/host public + URL de base du serveur media
  db.ts                # client Prisma
  server.ts            # API HTTP + OAuth + media + UI statique
  worker.ts            # process scheduler
  threads/client.ts    # client API Threads (OAuth, publish, refresh)
  services/            # accounts, tokens, posts, actions, apikeys, media, stats, queue, analytics
  routes/              # auth, accounts, posts, actions, apikeys, uploads, media, stats, queue, analytics
  middleware/auth.ts   # auth par clé API
  scheduler/scheduler.ts  # polling (posts, chaînes, actions, refresh tokens, cleanup, analytics)
prisma/schema.prisma   # modèle de données (+ queue_slots, metric_snapshots, post_insights)
public/                # UI : index.html (ops) + admin.html (stats) + analytics.html (graphes)
uploads/               # images temporaires (privé, hors web statique, gitignored)
```
