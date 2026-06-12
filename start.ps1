# Threads Manager — script de lancement (Windows / PowerShell)
#
#   .\start.ps1            -> mode DEV (hot-reload, API + worker dans un terminal)
#   .\start.ps1 -Prod      -> build + lance la version compilée (dist/)
#   .\start.ps1 -SkipDb    -> ne pas (re)synchroniser le schéma Prisma
#
# Vérifie Node, le .env, les dépendances, PostgreSQL et le schéma, puis démarre
# l'API (UI + OAuth + média) et le worker (scheduler) ensemble.

param(
  [switch]$Prod,
  [switch]$SkipDb
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Info($m)  { Write-Host $m -ForegroundColor Cyan }
function Ok($m)    { Write-Host $m -ForegroundColor Green }
function Warn($m)  { Write-Host $m -ForegroundColor Yellow }
function Fail($m)  { Write-Host $m -ForegroundColor Red }

Write-Host ""
Info "=========================================="
Info "  Threads Manager"
Info "=========================================="

# 1. Node
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node.js introuvable. Installe Node >= 20 : https://nodejs.org"
  exit 1
}
Info ("Node " + (node --version))

# 2. Fichier .env
if (-not (Test-Path ".env")) {
  if (Test-Path ".env.example") {
    Copy-Item ".env.example" ".env"
    Warn ".env manquant : copié depuis .env.example."
    Warn "Renseigne THREADS_APP_ID/SECRET, TOKEN_ENCRYPTION_KEY, ADMIN_PASSWORD, puis relance."
    exit 1
  }
  Fail ".env introuvable et pas de .env.example."
  exit 1
}

# 3. Dépendances
if (-not (Test-Path "node_modules")) {
  Info "Installation des dépendances (npm install)..."
  npm install
}

# 4. PostgreSQL joignable ?
$pg = Test-NetConnection -ComputerName localhost -Port 5432 -WarningAction SilentlyContinue
if (-not $pg.TcpTestSucceeded) {
  Warn "PostgreSQL ne répond pas sur localhost:5432."
  Warn "Démarre le service (ex: 'Get-Service postgresql*' / 'Start-Service postgresql-x64-16') puis relance."
} else {
  Info "PostgreSQL: OK (localhost:5432)"
}

# 5. Client Prisma + schéma
Info "Génération du client Prisma..."
npx prisma generate | Out-Null
if (-not $SkipDb) {
  Info "Synchronisation du schéma (prisma db push)..."
  npx prisma db push
}

# 6. Lancement
Write-Host ""
if ($Prod) {
  Info "Build TypeScript..."
  npm run build
  Ok "Lancement PRODUCTION (API + worker)... (Ctrl+C pour arrêter)"
  npm start
} else {
  Ok "Lancement DEV avec hot-reload (API + worker)... (Ctrl+C pour arrêter)"
  npm run dev
}
