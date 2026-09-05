#!/usr/bin/env bash
# Start the LiteLLM proxy that lets qa-pilot run on a Gemini key.
# Usage: ./scripts/litellm-proxy.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# Load qa-pilot/.env, then the repo-root .env. Both, because the provider key is a
# repo-wide secret and duplicating it into two files is how one of them goes stale.
# qa-pilot/.env is sourced first so a value set there wins.
for envfile in ./.env ../.env; do
  if [ -f "$envfile" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$envfile"
    set +a
  fi
done

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "GEMINI_API_KEY is not set. Add it to qa-pilot/.env:" >&2
  echo "  echo 'GEMINI_API_KEY=your-key-here' >> .env" >&2
  exit 1
fi

PORT="${LITELLM_PORT:-4444}"

echo "Starting LiteLLM proxy on http://localhost:${PORT}"
echo "  QA_PILOT_LLM_BASE_URL=http://localhost:${PORT}"
echo "  ANTHROPIC_API_KEY=sk-local-dev"
echo

# uvx runs litellm without installing it permanently.
exec uvx --from 'litellm[proxy]' litellm \
  --config litellm.config.yaml \
  --port "${PORT}"
