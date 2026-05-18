#!/usr/bin/env bash
# Capflow external healthcheck — useful для Uptime Kuma / Healthchecks.io
# или другого outside-the-host monitor.
#
# Checks:
#   1. API liveness: GET /health → status='ok'
#   2. API readiness: GET /health/ready → 200 (DB + Redis reachable)
#
# Exit codes:
#   0 — все ок
#   1 — liveness fail
#   2 — readiness fail
#
# Usage:
#   API_BASE_URL=https://cap-flow.ru/api ./healthcheck.sh

set -euo pipefail

API="${API_BASE_URL:-http://localhost:3000}"
TIMEOUT="${HEALTHCHECK_TIMEOUT:-5}"

if ! curl -sf --max-time "$TIMEOUT" "$API/health" >/dev/null; then
  echo "[FAIL] liveness: $API/health недоступен"
  exit 1
fi

if ! curl -sf --max-time "$TIMEOUT" "$API/health/ready" >/dev/null; then
  echo "[FAIL] readiness: $API/health/ready вернул не-2xx (DB/Redis?)"
  exit 2
fi

echo "[OK] $API healthy"
