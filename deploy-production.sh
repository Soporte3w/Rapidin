#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPO_ROOT="${REPO_ROOT:-$SCRIPT_DIR}"
readonly BACKEND_DIR="$REPO_ROOT/backend"
readonly FRONTEND_DIR="$REPO_ROOT/frontend"
readonly PM2_PROCESS="${PM2_PROCESS:-rapidin-backend}"
readonly WEB_ROOT="${WEB_ROOT:-/var/www/rapidin_front}"
readonly DEPLOY_LOCK_FILE="${DEPLOY_LOCK_FILE:-/var/lock/rapidin-deploy.lock}"

COMMIT_MESSAGE="${1:-}"
RELEASE_DIR=''
PREVIOUS_WEB_ROOT=''
WEB_SWAP_STARTED=0

log() {
  printf '[deploy] %s\n' "$*"
}

fail() {
  printf '[deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Uso:
  sudo ./deploy-production.sh ["mensaje del commit"]

Si el repositorio contiene cambios, el mensaje es obligatorio y el script
crea el commit antes del despliegue. Si está limpio, despliega el HEAD actual.

Variables opcionales:
  PM2_PROCESS             Nombre PM2 (default: rapidin-backend)
  WEB_ROOT                Destino frontend (default: /var/www/rapidin_front)
  WEB_OWNER_GROUP         Propietario del frontend, por ejemplo www-data:www-data
  BACKEND_HEALTHCHECK_URL URL HTTP opcional para validar el backend
USAGE
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "No se encontró el comando requerido: $1"
}

rollback_web_root() {
  local exit_code=$?

  if (( exit_code != 0 && WEB_SWAP_STARTED == 1 )); then
    printf '[deploy] Falló la publicación del frontend; intentando rollback.\n' >&2
    if [[ ! -e "$WEB_ROOT" && -n "$PREVIOUS_WEB_ROOT" && -d "$PREVIOUS_WEB_ROOT" ]]; then
      mv -- "$PREVIOUS_WEB_ROOT" "$WEB_ROOT" || true
    fi
  fi

  if (( exit_code != 0 )) && [[ -n "$RELEASE_DIR" && -d "$RELEASE_DIR" ]]; then
    printf '[deploy] Directorio temporal conservado para revisión: %s\n' "$RELEASE_DIR" >&2
  fi

  exit "$exit_code"
}

if [[ "${1:-}" == '-h' || "${1:-}" == '--help' ]]; then
  usage
  exit 0
fi

if (( $# > 1 )); then
  usage
  exit 2
fi

if (( EUID != 0 )); then
  fail "Ejecuta este script como root: sudo -E ./deploy-production.sh ..."
fi

for command_name in git node npm pm2 rsync flock mktemp stat; do
  require_command "$command_name"
done

[[ -d "$REPO_ROOT/.git" ]] || fail "No es un repositorio Git: $REPO_ROOT"
[[ -f "$BACKEND_DIR/package-lock.json" ]] || fail "Falta backend/package-lock.json"
[[ -f "$FRONTEND_DIR/package-lock.json" ]] || fail "Falta frontend/package-lock.json"

exec 9>"$DEPLOY_LOCK_FILE"
flock -n 9 || fail "Ya existe otro despliegue Rapidín en ejecución"

git_cmd=(git -c "safe.directory=$REPO_ROOT" -C "$REPO_ROOT")
current_branch="$("${git_cmd[@]}" branch --show-current)"
[[ "$current_branch" == 'main' ]] || fail "El despliegue solo está permitido desde main; rama actual: $current_branch"

working_tree_status="$("${git_cmd[@]}" status --porcelain=v1)"
if [[ -n "$working_tree_status" ]]; then
  [[ -n "$COMMIT_MESSAGE" ]] || fail "Hay cambios pendientes; proporciona el mensaje del commit"

  if printf '%s\n' "$working_tree_status" | grep -E '(^|/)(\.env($|\.)|node_modules/|dist/|uploads?/|backups?/)|\.(dump|bak)$' >/dev/null; then
    printf '%s\n' "$working_tree_status" >&2
    fail "Se detectaron credenciales, dependencias, builds, uploads o backups; no se hará commit automático"
  fi

  log "Preparando cambios y creando commit"
  "${git_cmd[@]}" add -A
  "${git_cmd[@]}" diff --cached --check
  "${git_cmd[@]}" commit -m "$COMMIT_MESSAGE"
else
  log "Repositorio limpio; se desplegará el commit $("${git_cmd[@]}" rev-parse --short HEAD)"
fi

log "Instalando dependencias del backend desde package-lock.json"
npm --prefix "$BACKEND_DIR" ci --omit=dev

pm2 describe "$PM2_PROCESS" >/dev/null 2>&1 || fail "No existe el proceso PM2: $PM2_PROCESS"
log "Reiniciando únicamente el backend PM2: $PM2_PROCESS"
pm2 restart "$PM2_PROCESS" --update-env

backend_pid="$(pm2 pid "$PM2_PROCESS" | tail -n 1 | tr -d '[:space:]')"
[[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || fail "PM2 no reportó un PID activo para $PM2_PROCESS"
log "Backend online con PID $backend_pid"

if [[ -n "${BACKEND_HEALTHCHECK_URL:-}" ]]; then
  require_command curl
  healthcheck_ok=0
  for attempt in {1..10}; do
    if curl --fail --silent --show-error --max-time 5 "$BACKEND_HEALTHCHECK_URL" >/dev/null; then
      healthcheck_ok=1
      break
    fi
    sleep 2
  done
  (( healthcheck_ok == 1 )) || fail "El healthcheck del backend no respondió correctamente"
  log "Healthcheck del backend correcto"
fi

log "Instalando dependencias y construyendo el frontend"
npm --prefix "$FRONTEND_DIR" ci
npm --prefix "$FRONTEND_DIR" run build
[[ -s "$FRONTEND_DIR/dist/index.html" ]] || fail "El build no generó frontend/dist/index.html"

web_parent="$(dirname -- "$WEB_ROOT")"
web_name="$(basename -- "$WEB_ROOT")"
install -d -m 755 "$web_parent"
RELEASE_DIR="$(mktemp -d "$web_parent/.${web_name}.release.XXXXXX")"

log "Copiando el build a $RELEASE_DIR"
rsync -a --delete --chmod=D755,F644 "$FRONTEND_DIR/dist/" "$RELEASE_DIR/"

if [[ -n "${WEB_OWNER_GROUP:-}" ]]; then
  web_owner_group="$WEB_OWNER_GROUP"
elif [[ -e "$WEB_ROOT" ]]; then
  web_owner_group="$(stat -c '%u:%g' "$WEB_ROOT")"
else
  web_owner_group='root:root'
fi
chown -R "$web_owner_group" "$RELEASE_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
PREVIOUS_WEB_ROOT="$web_parent/${web_name}.previous.$timestamp"
trap rollback_web_root EXIT

WEB_SWAP_STARTED=1
if [[ -e "$WEB_ROOT" ]]; then
  [[ ! -e "$PREVIOUS_WEB_ROOT" ]] || fail "Ya existe el destino de rollback: $PREVIOUS_WEB_ROOT"
  mv -- "$WEB_ROOT" "$PREVIOUS_WEB_ROOT"
else
  PREVIOUS_WEB_ROOT=''
fi
mv -- "$RELEASE_DIR" "$WEB_ROOT"
RELEASE_DIR=''
WEB_SWAP_STARTED=0
trap - EXIT

log "Frontend publicado en $WEB_ROOT"
if [[ -n "$PREVIOUS_WEB_ROOT" ]]; then
  log "Rollback conservado en $PREVIOUS_WEB_ROOT"
fi
log "Despliegue terminado en commit $("${git_cmd[@]}" rev-parse --short HEAD)"
log "La migración 041_api_performance_indexes.sql NO fue aplicada automáticamente"
