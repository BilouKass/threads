# Documentation technique — Threads Manager

Gestionnaire multi-comptes pour l'API **Threads (Meta)** : connexion OAuth, stockage chiffré
et refresh des tokens, planification de posts (texte / image / vidéo / carrousel mixte /
sondage / spoiler), enchaînements, file d'attente, réponses, et analytics historisées.
Pilotable via **interface web** ou **API HTTP** (clé API, idéal n8n).

> Ce document décrit l'architecture, l'authentification par clé API, la construction de la base
> de données, et le calcul des données d'analytics. La documentation **fonction par fonction**
> (rôle / entrées / sorties) se trouve directement dans le code sous forme de commentaires JSDoc.

---

## 1. Vue d'ensemble

L'application est composée de **deux processus Node.js** qui partagent le **même code** et la
**même base PostgreSQL** :

| Processus | Fichier d'entrée | Rôle |
|---|---|---|
| **API** | `src/server.ts` | Sert l'API HTTP `/api/*`, le flux OAuth `/auth/*`, le serveur média signé, et l'UI web statique. |
| **Worker** | `src/worker.ts` | Boucle de planification : publie les posts dus, exécute les réponses, rafraîchit les tokens, capture les analytics, nettoie les fichiers temporaires. |

Ils communiquent **uniquement via la base de données** (pas d'appel direct entre eux) : l'API
écrit des « jobs » (posts planifiés, actions), le worker les lit et les exécute.

```
   Navigateur ─┐
   n8n / curl ─┼─▶  API (Fastify, :3000)  ──┐ écrit posts/actions/slots
   Scripts    ─┘        │  + serveur média (:8080, signé)
                        │                    ▼
                        │            ┌─────────────────┐
                        │            │   PostgreSQL     │  accounts, scheduled_posts,
                        │            │   (Prisma ORM)   │  actions, api_keys, queue_slots,
                        │            └─────────────────┘  metric_snapshots, post_insights…
                        │                    ▲
                        ▼                    │ lit/écrit
                 Threads Graph API  ◀── Worker (scheduler) ──┘
                 graph.threads.net      publie, refresh, analytics
```

### Stack technique

| Couche | Technologie | Où |
|---|---|---|
| Langage | TypeScript (ESM, Node ≥ 20) | tout `src/` |
| Serveur HTTP | **Fastify** | `src/server.ts`, `src/routes/*` |
| ORM / DB | **Prisma** + **PostgreSQL** | `prisma/schema.prisma`, `src/db.ts` |
| Validation | **zod** | `src/config.ts`, chaque route |
| HTTP sortant | **undici** | `src/threads/client.ts` |
| Logs | **pino** | `src/logger.ts` |
| Conteneurs | **Docker Compose** | `docker-compose.yml` |

---

## 2. Architecture en couches — « qui repose sur quoi »

Les dépendances vont **du haut vers le bas** (le haut utilise le bas, jamais l'inverse) :

```
┌───────────────────────────────────────────────────────────────────┐
│  ENTRÉES                                                           │
│  public/*.html + *.js   (UI web)        routes/*.ts (endpoints)    │
│  server.ts (compose tout)               worker.ts (lance le loop)  │
└───────────────┬───────────────────────────────────┬───────────────┘
                │                                   │
                ▼                                   ▼
┌───────────────────────────────┐    ┌──────────────────────────────┐
│  MIDDLEWARE / SCHEDULER        │    │  SERVICES (logique métier)    │
│  middleware/auth.ts            │    │  accounts, tokens, posts,     │
│  scheduler/scheduler.ts        │───▶│  actions, queue, analytics,   │
│                                │    │  stats, apikeys, media        │
└───────────────────────────────┘    └───────────────┬──────────────┘
                                                      │
                       ┌──────────────────────────────┼─────────────────┐
                       ▼                              ▼                  ▼
              ┌──────────────────┐        ┌────────────────────┐  ┌─────────────┐
              │  threads/client  │        │  db.ts (Prisma)    │  │  crypto.ts  │
              │  (Graph API)     │        │  config.ts         │  │  publicUrl  │
              └──────────────────┘        └────────────────────┘  └─────────────┘
```

### Rôle de chaque brique

| Module | Repose sur | Rôle |
|---|---|---|
| `src/config.ts` | zod, `.env` | Charge et **valide** la configuration (variables d'env). Tout le monde l'importe. Échoue au démarrage si une variable est invalide. |
| `src/logger.ts` | pino, `config` | Logger applicatif partagé. |
| `src/db.ts` | `@prisma/client` | Instance unique du client Prisma (`prisma`). |
| `src/crypto.ts` | `config` (clé), `node:crypto` | Chiffre/déchiffre les tokens (AES-256-GCM) et génère/hash les clés API. |
| `src/publicUrl.ts` | `config`, undici | Résout l'URL publique du serveur média (IP auto-détectée ou fixée). |
| `src/threads/client.ts` | undici, `logger` | **Client bas niveau** de l'API Threads (OAuth, publication, refresh, insights). Aucune dépendance à la DB. |
| `src/services/*` | `db`, `crypto`, `threads/client` | **Logique métier** : un service par domaine (voir §7). C'est ici que vivent les règles. |
| `src/middleware/auth.ts` | `services/apikeys` | Vérifie la clé API sur les routes protégées. |
| `src/routes/*` | `services/*`, `middleware/auth` | Déclare les endpoints HTTP, valide les entrées (zod), appelle les services. |
| `src/scheduler/scheduler.ts` | `services/*` | Boucle périodique du worker. |
| `src/server.ts` | routes, `db`, `publicUrl` | Assemble Fastify, enregistre les routes, démarre les 2 serveurs (API + média). |
| `src/worker.ts` | `scheduler`, `db` | Démarre la boucle du scheduler. |

**Règle d'or** : les routes ne contiennent **pas** de logique métier — elles valident et délèguent
aux services. Les services ne connaissent **pas** Fastify — ils sont réutilisables par le worker.

---

## 2bis. Utilisateurs, rôles et sessions (UI humaine)

L'interface web est protégée par une **connexion utilisateur** (identifiant + mot de passe →
**cookie de session** httpOnly). Deux rôles :

| Rôle | Peut | Ne peut pas |
|---|---|---|
| **ADMIN** | Tout : comptes, posts, analytics, **clés API**, **gestion des utilisateurs**, tous les comptes | — |
| **VA** | Publier / répondre / planifier / file d'attente, voir Analytics & stats, connecter/déconnecter des comptes, gérer les créneaux — **uniquement sur ses comptes assignés** | Accès aux **clés API** et à la **gestion des utilisateurs** |

**Scoping par compte** : un VA ne voit et n'agit que sur les comptes qui lui sont **assignés**
(table `user_accounts`). Quand un VA connecte un compte (OAuth), celui-ci lui est **auto-assigné**.

**Deux mécanismes d'auth coexistent** (`src/middleware/auth.ts` → `authenticate`) :
1. **Cookie de session** (humains via l'UI) → essayé en premier ; porte le rôle + comptes assignés.
2. **Clé API** (machines / n8n) → traitée comme **ADMIN** (accès complet, sans scoping).

Gardes : `requireAdmin` (clés API, utilisateurs), `assertAccountAccess(req, accountId)` et
`accountIdScope(req)` (filtre les listes aux comptes autorisés).

**Bootstrap du 1er admin** : si aucun admin n'existe et que `ADMIN_PASSWORD` est défini, un admin
(`ADMIN_USERNAME`) est créé au démarrage. Sinon : `npm run seed:user -- <user> <pass> admin`.

**Endpoints** : `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` ; `GET/POST/PATCH/DELETE
/api/users` et `…/api/users/:id/accounts` (admin). Pages UI : `login.html`, `users.html`.

## 3. Authentification par clé API (`X-API-Key`)

Toutes les routes `/api/*` sont protégées par une **clé API**. Les routes OAuth (`/auth/*`), le
serveur média signé (`/media/*`) et les fichiers statiques sont **publics**.

### 3.1 Comment une clé est fabriquée

Fonction `generateApiKey()` dans `src/crypto.ts` :

```
raw    = "tk_" + 24 octets aléatoires en base64url     ← la VRAIE clé (montrée une seule fois)
hash   = SHA-256(raw)  (hex, 64 caractères)            ← seul élément stocké en base
prefix = 10 premiers caractères de raw                 ← pour identifier la clé dans l'UI
```

En base (`api_keys`), on stocke **uniquement** `hash` + `prefix` (+ `name`, `lastUsedAt`,
`revokedAt`). **La clé brute n'est jamais stockée** : impossible de la retrouver depuis la base.

### 3.2 Comment une requête est authentifiée

Le middleware `requireApiKey` (`src/middleware/auth.ts`) est branché en `preHandler` sur chaque
groupe de routes protégées. Déroulé :

```
1. Lire l'en-tête   X-API-Key: <clé>      (ou   Authorization: Bearer <clé>)
2. Si absent           → 401 "Missing API key"
3. validateApiKey(clé) :  hash = SHA-256(clé)  →  SELECT * FROM api_keys WHERE hash = ?
4. Si introuvable OU revokedAt non nul  → 401 "Invalid or revoked API key"
5. Sinon : met à jour lastUsedAt (best-effort, non bloquant) et attache req.apiKeyId
6. La requête continue vers le handler
```

Comme on compare des **hash** (lookup par index unique), la clé en clair ne transite jamais en
base et n'apparaît pas dans les logs.

### 3.3 La clé « master » au premier démarrage

Au boot de l'API, `ensureMasterKey()` (`src/services/apikeys.ts`) vérifie s'il existe au moins une
clé active. Sinon, il en crée une nommée `master (auto-created)` et **affiche la clé brute une
seule fois** dans les logs. À récupérer immédiatement.

### 3.4 Gérer les clés

| Action | Endpoint / commande |
|---|---|
| Lister (sans la valeur) | `GET /api/keys` |
| Créer (renvoie la clé une fois) | `POST /api/keys { "name": "n8n" }` |
| Révoquer | `DELETE /api/keys/:id` (pose `revokedAt`) |
| Créer en CLI | `npm run seed:apikey -- "ma clé"` |

### 3.5 Utilisation (client)

```bash
curl -H "X-API-Key: tk_xxxxxxxx" http://localhost:3000/api/accounts
# ou
curl -H "Authorization: Bearer tk_xxxxxxxx" http://localhost:3000/api/accounts
```

Dans n8n : credential **Header Auth** `Name = X-API-Key`, `Value = <clé>`.

### 3.6 Pourquoi OAuth n'utilise PAS la clé API

`/auth/threads` et `/auth/threads/callback` sont **publics** : c'est le **navigateur** de
l'utilisateur qui suit la redirection OAuth. La sécurité du callback repose sur le paramètre
**`state`** (anti-CSRF, table `oauth_states`), pas sur la clé API. Voir §6.

---

## 4. Construire / initialiser la base de données

La base est décrite par **un seul fichier** : `prisma/schema.prisma`. C'est la source de vérité.

### 4.1 Variable requise

```env
DATABASE_URL=postgresql://threads:threads@localhost:5432/threads?schema=public
```

### 4.2 Méthode A — `prisma db push` (utilisée par ce projet)

Synchronise le schéma **sans fichiers de migration** (idéal en phase de dev) :

```bash
npm run db:push          # = prisma db push  (crée/aligne les tables + régénère le client)
```

- Crée les tables manquantes, ajoute les colonnes, etc.
- Si un changement supprime des données (ex. retirer une valeur d'enum), Prisma exige
  `--accept-data-loss` :
  ```bash
  npx prisma db push --accept-data-loss
  ```
- Régénère aussi le **client Prisma** typé (`@prisma/client`). Pour le forcer seul :
  ```bash
  npx prisma generate
  ```

### 4.3 Méthode B — Docker Compose (tout-en-un)

`docker-compose.yml` orchestre 4 services : `db` (Postgres), `migrate` (applique le schéma via
`prisma db push`), `api`, `worker`.

```bash
docker compose up --build
```

Le service `migrate` attend que Postgres soit *healthy*, applique le schéma, puis `api` et
`worker` démarrent.

### 4.4 Méthode C — PostgreSQL natif (Windows, sans Docker)

```powershell
winget install -e --id PostgreSQL.PostgreSQL.16 --override "--mode unattended --superpassword postgres --serverport 5432"
# Créer le rôle + la base applicative :
psql -U postgres -c "CREATE ROLE threads LOGIN PASSWORD 'threads';"
psql -U postgres -c "CREATE DATABASE threads OWNER threads;"
# Puis :
npm run db:push
```

### 4.5 Passer aux migrations versionnées (prod)

Pour de la production, on remplacera `db push` par des migrations :

```bash
npx prisma migrate dev --name init      # génère prisma/migrations/*
npx prisma migrate deploy               # applique en prod
```

---

## 5. Modèle de données

Toutes les tables sont définies dans `prisma/schema.prisma`. Les noms SQL sont en `snake_case`
(via `@@map`).

| Modèle (table) | Rôle | Champs clés |
|---|---|---|
| **Account** (`accounts`) | Un compte Threads connecté | `threadsUserId` (unique), `accessToken` (**chiffré**), `tokenType`, `scope`, `expiresAt`, `disabled` |
| **ScheduledPost** (`scheduled_posts`) | Un post à publier (ou réponse, ou maillon de chaîne) | `text`, `mediaType` (TEXT/IMAGE/VIDEO/CAROUSEL), `media` (JSON `[{type,url}]`), `poll` (JSON), `spoilers` (JSON), `isSpoilerMedia`, `replyToId`, `chainId`, `chainOrder`, `dependsOnPostId`, `scheduledAt`, `status`, `attempts`, `publishedId` |
| **Action** (`actions`) | Une action sur un élément existant (aujourd'hui : **réponse**) | `type` (REPLY), `targetId`, `text`, `status`, `resultId` |
| **ApiKey** (`api_keys`) | Clé d'accès programmatique | `hash` (SHA-256, unique), `prefix`, `revokedAt` |
| **OAuthState** (`oauth_states`) | Jeton anti-CSRF temporaire du flux OAuth | `state` (PK) |
| **QueueSlot** (`queue_slots`) | Créneau récurrent de publication (file d'attente) | `dayOfWeek` (0=dim…6=sam), `hour`, `minute` |
| **MetricSnapshot** (`metric_snapshots`) | Snapshot **quotidien** d'un compte (analytics) | `day` (date), `followers`, `views`, `likes`, `replies`, `reposts`, `quotes` ; unique `(accountId, day)` |
| **PostInsight** (`post_insights`) | Derniers insights d'un post publié | `mediaId` (unique), `views`, `likes`, `replies`, `reposts`, `quotes`, `shares`, `permalink`, `postedAt` |

**Statuts d'un job** (`JobStatus`) : `PENDING → PROCESSING → PUBLISHED` (ou `FAILED`,
`CANCELLED`). Voir §8.

**Relations** : `Account` possède (cascade delete) ses `scheduledPosts`, `actions`, `queueSlots`,
`snapshots`, `postInsights`. Supprimer un compte supprime toutes ses données associées.

---

## 6. Cycle de vie OAuth & tokens

1. `GET /auth/threads` → génère un `state` (stocké), redirige vers la page d'autorisation Threads.
2. L'utilisateur autorise → Threads redirige le **navigateur** vers `GET /auth/threads/callback?code=…&state=…`.
3. Le serveur valide/consomme le `state`, puis (appels **sortants**) :
   - `exchangeCodeForToken` → token **court** (1 h),
   - `exchangeForLongLivedToken` → token **long** (~60 j),
   - chiffre et stocke le token (`services/tokens.ts` → `crypto.encrypt`).
4. **Refresh** : le worker rafraîchit (toutes les 6 h) les tokens dont l'expiration approche
   (`TOKEN_REFRESH_THRESHOLD_DAYS`), via `refreshExpiringTokens()`.

> Le serveur ne **reçoit** jamais de token de l'extérieur : il reçoit seulement le `code` (via le
> navigateur) puis **demande** les tokens à Threads. Voir aussi le README.

---

## 7. Les services (logique métier)

| Service | Responsabilité | Fonctions principales |
|---|---|---|
| `accounts.ts` | Connexion / liste / activation / suppression de comptes | `connectAccountFromShortLivedToken`, `listAccounts`, `getAccountOrThrow`, `setDisabled`, `deleteAccount` |
| `tokens.ts` | Stockage chiffré + échange + refresh des tokens | `getAccessToken`, `storeToken`, `upgradeAndStore`, `refreshAccount`, `refreshExpiringTokens` |
| `posts.ts` | Planification + **publication** (texte/image/vidéo/carrousel/sondage/spoiler), chaînes, bulk | `schedulePost`, `schedulePostsBulk`, `scheduleChain`, `publishPost`, `mediaUrls`, `cancelPost` |
| `actions.ts` | Réponses (REPLY) | `createAction`, `runAction`, `listActions` |
| `queue.ts` | File d'attente : créneaux + prochain créneau libre | `listSlots`, `addSlot`, `deleteSlot`, `nextQueueTime`, `addToQueue` |
| `media.ts` | Upload privé + URL signée/expirante + suppression | `saveUpload`, `buildSignedUrl`, `verifySignedRequest`, `deleteByUrls`, `cleanupExpiredUploads` |
| `analytics.ts` | Capture + lecture des métriques historisées | `captureSnapshot`, `capturePostInsights`, `captureAllDaily`, `getAnalytics`, `getPostAnalytics` |
| `stats.ts` | Stats « instantanées » d'un compte (dashboard admin) | `getAccountStats`, `getOverview` |
| `apikeys.ts` | Clés API | `createApiKey`, `validateApiKey`, `listApiKeys`, `revokeApiKey`, `ensureMasterKey` |

> Le **rôle, les entrées et les sorties** de chaque fonction sont documentés en JSDoc directement
> au-dessus de la fonction dans le fichier correspondant.

### Publication d'un post (`publishPost`)

Threads publie en **2 temps** : créer un *container* puis le *publier*.

- **Texte** : container `TEXT` (+ `poll_attachment`, `text_entities` si spoiler).
- **Image / Vidéo** : container `IMAGE`/`VIDEO` avec l'URL média (+ `is_spoiler_media` si demandé).
- **Carrousel** : 1 container enfant par média (on attend la fin de traitement des vidéos), puis un
  container `CAROUSEL` référençant les enfants.
- Les containers média sont « attendus » (`waitForContainer`) jusqu'au statut `FINISHED` avant
  publication.
- **Chaîne** : chaque maillon dépend du précédent (`dependsOnPostId`) ; le worker fixe son
  `replyToId` au `publishedId` du prédécesseur une fois celui-ci publié.

---

## 8. Le worker / scheduler

`src/scheduler/scheduler.ts` exécute une boucle toutes les `SCHEDULER_POLL_SECONDS` (15 s par
défaut). À chaque tick :

| Étape | Fréquence | Détail |
|---|---|---|
| `maybeRefreshTokens` | toutes les 6 h | Refresh des tokens proches de l'expiration. |
| `maybeCleanupUploads` | toutes les 30 min | Supprime les fichiers média orphelins (TTL dépassé). |
| `maybeCaptureAnalytics` | toutes les 12 h | Capture snapshots + insights par post (voir §9). |
| `processDuePosts` | chaque tick | Publie les posts `PENDING` dus. |
| `processDueActions` | chaque tick | Exécute les réponses `PENDING` dues. |

**Claim atomique** (anti-doublon, multi-worker) : un post n'est traité que si
`updateMany(status: PENDING → PROCESSING)` renvoie `count = 1`. Le gagnant publie ; en cas
d'échec, `handleFailure` ré-essaie jusqu'à `maxAttempts` puis passe en `FAILED`.

**Dépendances de chaîne** : `resolveDependency` met un maillon en attente (`wait`) tant que son
prédécesseur n'est pas `PUBLISHED`, le marque `FAILED` si le prédécesseur a échoué, ou fixe son
`replyToId` et le laisse passer (`ready`).

---

## 9. Analytics — données affichées et calculs

L'API Threads ne renvoie qu'un **instantané** : pour tracer des **courbes dans le temps**, le
worker **historise** lui-même des snapshots quotidiens. Tout cela nécessite le scope
**`threads_manage_insights`** (les comptes connectés avant son ajout doivent être reconnectés).

### 9.1 Capture (écriture)

Toutes les 12 h, `captureAllDaily()` parcourt les comptes actifs :

- **`captureSnapshot(account)`** :
  - `followers` ← métrique `followers_count` (valeur **cumulée**, via `total_value`).
  - `views / likes / replies / reposts / quotes` ← métriques d'engagement demandées sur une
    fenêtre **des dernières 24 h** (`since = until − 86400`).
  - **Upsert** dans `metric_snapshots` sur la clé `(accountId, day)` → **un point par jour** (la
    dernière capture du jour écrase la précédente).
- **`capturePostInsights(account)`** : récupère les ~25 derniers posts (`getUserThreads`), puis
  pour chacun `getMediaInsights` (views/likes/replies/reposts/quotes/shares) et **upsert** par
  `mediaId` dans `post_insights` (on garde le dernier état connu).

> Helper `metricTotal` : si la métrique a un `total_value`, on prend cette valeur ; sinon on
> **somme** les `values[]` (séries journalières).

### 9.2 Lecture & calculs (affichage)

**`getAnalytics(accountId, days)`** lit les snapshots des `days` derniers jours et renvoie :

- **`series`** : un point par jour `{ day, followers, views, likes, replies, reposts, quotes }`
  → alimente les graphiques de la page **Analytics** (courbe d'abonnés, barres de vues/jour).
- **`summary`** :
  | Champ | Calcul |
  |---|---|
  | `followersStart` / `followersEnd` | 1er / dernier `followers` **non nul** de la période |
  | `followersGrowth` | `followersEnd − followersStart` (≥ 2 points requis, sinon `null`) |
  | `totalViews` (et likes/replies/reposts/quotes) | **somme** des valeurs journalières sur la période |
  | `points` | nombre de snapshots dans la période |

**`getPostAnalytics(accountId)`** : les `post_insights` **triés par `views` décroissantes**
(top posts). Affiché dans le tableau « Meilleurs posts ».

### 9.3 Ce que montre chaque écran

| Écran | Source | Contenu |
|---|---|---|
| **Analytics** (`analytics.html`) | `getAnalytics` + `getPostAnalytics` | Courbe d'abonnés, vues/jour, tuiles (croissance, cumuls), top posts. Bouton « Capturer maintenant » = capture immédiate. |
| **Administration** (`admin.html`) | `stats.getAccountStats` | Stats **instantanées** par compte : abonnés + engagement (sur N jours, **appel direct** à l'API au chargement) + compteurs de la DB (publiés / en attente / échecs). |
| **Opérations** (`index.html`) | endpoints posts/actions/queue | Planifier, répondre, enchaînements, file d'attente. |

> **Différence clé** : la page **Admin** appelle l'API Threads **en direct** (instantané, pas
> d'historique) ; la page **Analytics** lit les **snapshots historisés** (tendances). Les deux
> requièrent `threads_manage_insights`.

### 9.4 Précisions / limites de calcul

- L'engagement d'un snapshot est une fenêtre **glissante de 24 h** prise au moment de la capture.
  Les `total*` du résumé sont donc une **somme de fenêtres journalières** (approximation, pas un
  cumul exact « lifetime »).
- Les courbes se remplissent **au fil des jours** (1 point/jour). Il faut **≥ 2 jours** de captures
  pour afficher une tendance d'abonnés.
- Threads n'expose **pas** de total exact de posts : l'admin affiche les posts publiés via l'app +
  un échantillon récent (≤ 100).

---

## 10. Pipeline média (images / vidéos)

L'API Threads **télécharge** les médias depuis une URL : on ne lui envoie jamais d'octets bruts.

1. `POST /api/uploads` stocke le fichier **en privé** (dossier `uploads/`, hors `public/`).
2. Renvoie une **URL signée et expirante** : `<base>/media/<aléatoire>?exp=…&sig=<HMAC>`.
   - `sig` = HMAC-SHA256 (clé dérivée de `TOKEN_ENCRYPTION_KEY`) sur `filename.exp` → URL non devinable.
   - La route `/media` est servie **à la fois** sur le serveur média dédié (`MEDIA_PORT`) **et** sur
     l'API (`PORT`). Ainsi, deux modèles d'exposition marchent : (a) exposer le port `MEDIA_PORT`
     en direct (IP publique), ou (b) **un seul tunnel** (ex. ngrok) vers le port de l'API qui sert
     alors OAuth + images. `<base>` vient de `MEDIA_PUBLIC_BASE_URL` (ou `MEDIA_PUBLIC_HOST:MEDIA_PORT`).
3. Meta télécharge le média au moment de la publication.
4. Le worker **supprime** le fichier après publication, et balaie les orphelins (TTL
   `MEDIA_SIGNED_URL_TTL_MINUTES`).

---

## 11. Configuration (`.env`)

Validée par `src/config.ts` (zod) au démarrage — l'app refuse de booter si une variable est
invalide.

| Variable | Rôle |
|---|---|
| `PORT`, `HOST` | Serveur admin/API/UI. |
| `DATABASE_URL` | Connexion PostgreSQL. |
| `THREADS_APP_ID`, `THREADS_APP_SECRET`, `THREADS_REDIRECT_URI`, `THREADS_SCOPES` | App Meta + OAuth. |
| `TOKEN_ENCRYPTION_KEY` | **64 hex (32 octets)** — chiffrement AES-256-GCM des tokens + signature des URL média. |
| `SCHEDULER_POLL_SECONDS`, `TOKEN_REFRESH_THRESHOLD_DAYS` | Cadence du worker / seuil de refresh. |
| `MEDIA_PORT`, `MEDIA_HOST`, `MEDIA_PUBLIC_HOST`, `MEDIA_PUBLIC_BASE_URL`, `MEDIA_SIGNED_URL_TTL_MINUTES` | Serveur média / exposition publique. |

---

## 12. Démarrer en local (résumé)

```bash
cp .env.example .env           # renseigner les variables (clé hex, creds Meta…)
npm install
npm run db:push                # crée le schéma (Postgres doit tourner)
npm run dev:api                # terminal 1 : API + UI + média
npm run dev:worker             # terminal 2 : scheduler
# UI : http://localhost:3000   (coller la clé API affichée au 1er boot dans les logs)
```

Voir le **README** pour les exemples d'API (posts, sondages, spoilers, enchaînements, file
d'attente, analytics) et l'intégration n8n.
