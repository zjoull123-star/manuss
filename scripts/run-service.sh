#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
SERVICE_KIND="${1:-}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

export OPENCLAW_DB_MODE="${OPENCLAW_DB_MODE:-prisma}"
export DATABASE_URL="${DATABASE_URL:-file:../.data/openclaw-manus.db}"
export OPENCLAW_WORKSPACE_ROOT="${OPENCLAW_WORKSPACE_ROOT:-$ROOT_DIR/.data/tasks}"
export OPENCLAW_API_BASE_URL="${OPENCLAW_API_BASE_URL:-http://127.0.0.1:3000}"
export OPENCLAW_MANUS_API_BASE_URL="${OPENCLAW_MANUS_API_BASE_URL:-http://127.0.0.1:3000}"

cd "$ROOT_DIR"

case "$SERVICE_KIND" in
  api)
    exec node dist/apps/api/src/index.js
    ;;
  worker)
    exec node dist/apps/worker/src/index.js
    ;;
  *)
    echo "usage: $0 <api|worker>" >&2
    exit 2
    ;;
esac
