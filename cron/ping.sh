#!/usr/bin/env bash
# Mark's cron sidecar — one container per Railway cron service.
#
# Behaviour driven by env vars:
#   MARK_URL          (required) — base URL of Mark, e.g. https://mark-agent-production.up.railway.app
#   CRON_SECRET       (required) — Bearer secret matching Mark's CRON_SECRET
#   MARK_ACTION       (required) — "poll" | "brief"
#   MARK_BRIEF_TYPE   (required when MARK_ACTION=brief) — daily | restricted | weekly | monthly
#
# Exits non-zero on failure so Railway records the cron run as failed.
set -euo pipefail

if [[ -z "${MARK_URL:-}" ]]; then
  echo "[cron] MARK_URL not set" >&2
  exit 1
fi
if [[ -z "${CRON_SECRET:-}" ]]; then
  echo "[cron] CRON_SECRET not set" >&2
  exit 1
fi
ACTION="${MARK_ACTION:-poll}"

if [[ "${ACTION}" == "poll" ]]; then
  ENDPOINT="${MARK_URL%/}/api/cron/poll"
  PAYLOAD=""
elif [[ "${ACTION}" == "brief" ]]; then
  if [[ -z "${MARK_BRIEF_TYPE:-}" ]]; then
    echo "[cron] MARK_ACTION=brief requires MARK_BRIEF_TYPE" >&2
    exit 1
  fi
  ENDPOINT="${MARK_URL%/}/api/cron/brief"
  PAYLOAD="{\"briefType\":\"${MARK_BRIEF_TYPE}\"}"
else
  echo "[cron] unknown MARK_ACTION='${ACTION}' (expected: poll | brief)" >&2
  exit 1
fi

echo "[cron] $(date -u '+%Y-%m-%dT%H:%M:%SZ') triggering ${ENDPOINT} (action=${ACTION}${MARK_BRIEF_TYPE:+, type=${MARK_BRIEF_TYPE}})"

# --max-time 290 keeps us under Railway's 5min default kill.
if [[ -n "${PAYLOAD}" ]]; then
  http_code=$(curl --silent --show-error --write-out '%{http_code}' --output /tmp/body.txt \
    --max-time 290 \
    -X POST \
    -H "Authorization: Bearer ${CRON_SECRET}" \
    -H "Content-Type: application/json" \
    --data "${PAYLOAD}" \
    "${ENDPOINT}")
else
  http_code=$(curl --silent --show-error --write-out '%{http_code}' --output /tmp/body.txt \
    --max-time 290 \
    -X POST \
    -H "Authorization: Bearer ${CRON_SECRET}" \
    "${ENDPOINT}")
fi

echo "[cron] response ${http_code}:"
cat /tmp/body.txt
echo

if [[ "${http_code}" -ge 200 && "${http_code}" -lt 300 ]]; then
  exit 0
fi
exit 1
