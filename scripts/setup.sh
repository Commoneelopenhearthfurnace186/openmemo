#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

bold()   { printf '\033[1m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*"; }

if [[ ! -f .env ]]; then
  red "No .env found. Run:"
  echo "  cp .env.example .env"
  echo "  \$EDITOR .env"
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

REQUIRED=(SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY OWNER_CHAT_ID TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET LLM_API_KEY)
missing=()
for v in "${REQUIRED[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    missing+=("$v")
  fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
  red "Missing in .env: ${missing[*]}"
  exit 1
fi

PROJECT_REF="$(echo "$SUPABASE_URL" | sed -E 's|https?://([^.]+)\..*|\1|')"
[[ -n "$PROJECT_REF" ]] || { red "Could not parse PROJECT_REF from SUPABASE_URL"; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || { red "Install $1 first ($2)"; exit 1; }; }
need curl     "https://curl.se/"
need supabase "https://supabase.com/docs/guides/cli"
need node     "https://nodejs.org/"
need npx      "comes with Node 18+"

if ! supabase projects list >/dev/null 2>&1; then
  red "Supabase CLI is not logged in. Run this once and re-run setup:"
  echo "  supabase login"
  echo
  echo "If you prefer a non-interactive token (CI), set SUPABASE_ACCESS_TOKEN."
  exit 1
fi

bold "==> 1/7  Linking Supabase project ($PROJECT_REF)"
supabase link --project-ref "$PROJECT_REF" >/dev/null
green "    linked"

bold "==> 2/7  Applying database migrations"
supabase db push --linked --yes
green "    migrations applied"

bold "==> 3/7  Pushing secrets to the Edge runtime"
supabase secrets set --env-file .env --project-ref "$PROJECT_REF" >/dev/null
green "    secrets pushed"

bold "==> 4/7  Deploying Edge Functions (this can take a minute)"
supabase functions deploy telegram-webhook --no-verify-jwt --project-ref "$PROJECT_REF" >/dev/null
supabase functions deploy dispatch-reminder --project-ref "$PROJECT_REF" >/dev/null
supabase functions deploy calendar --no-verify-jwt --project-ref "$PROJECT_REF" >/dev/null
supabase functions deploy pulse --project-ref "$PROJECT_REF" >/dev/null
green "    deployed: telegram-webhook, dispatch-reminder, calendar, pulse"

bold "==> 5/7  Configuring cron URLs and calendar token"
SR_KEY_ESCAPED=${SUPABASE_SERVICE_ROLE_KEY//\'/\'\'}
SQL_FILE="$(mktemp)"
cat > "$SQL_FILE" <<SQL
INSERT INTO app_config (id, dispatcher_url, service_role_key)
VALUES (1, 'https://${PROJECT_REF}.supabase.co/functions/v1/dispatch-reminder', '${SR_KEY_ESCAPED}')
ON CONFLICT (id) DO UPDATE
  SET dispatcher_url = EXCLUDED.dispatcher_url,
      service_role_key = EXCLUDED.service_role_key;

INSERT INTO pulse_config (id, pulse_url, service_role_key)
VALUES (1, 'https://${PROJECT_REF}.supabase.co/functions/v1/pulse', '${SR_KEY_ESCAPED}')
ON CONFLICT (id) DO UPDATE
  SET pulse_url = EXCLUDED.pulse_url,
      service_role_key = EXCLUDED.service_role_key;

INSERT INTO calendar_access (id, token)
VALUES (1, encode(gen_random_bytes(24), 'hex'))
ON CONFLICT (id) DO NOTHING;
SQL
if supabase db query --linked --agent=no -f "$SQL_FILE" >/dev/null 2>&1; then
  green "    cron URLs and calendar token saved"
  rm -f "$SQL_FILE"
else
  red "    Could not run SQL via the CLI."
  red "    THIS STEP IS REQUIRED — without it, cron jobs cannot deliver reminders."
  yellow "    Open the Supabase SQL editor (Database -> SQL Editor) and paste this once:"
  echo
  cat "$SQL_FILE"
  echo
  rm -f "$SQL_FILE"
  yellow "    Then re-run ./scripts/setup.sh."
  exit 1
fi

bold "==> 6/7  Registering Telegram webhook"
WEBHOOK_URL="https://${PROJECT_REF}.supabase.co/functions/v1/telegram-webhook"
WEBHOOK_RESPONSE=$(curl -fsS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WEBHOOK_URL}" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message","edited_message","callback_query"]') || {
  red "    Failed to register the Telegram webhook. Check TELEGRAM_BOT_TOKEN."
  exit 1
}
echo "$WEBHOOK_RESPONSE" | grep -q '"ok":true' || {
  red "    Telegram rejected the webhook:"
  echo "$WEBHOOK_RESPONSE"
  exit 1
}
green "    webhook registered: ${WEBHOOK_URL}"

CAL_TOKEN=$(curl -fsS \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  "${SUPABASE_URL}/rest/v1/calendar_access?select=token&id=eq.1" \
  | sed -E 's/.*"token":"([^"]+)".*/\1/')

ANON_KEY="${SUPABASE_ANON_KEY:-}"

bold "==> 7/7  Web calendar"
DEPLOY_CAL="${DEPLOY_CALENDAR:-ask}"
CAL_URL=""

CAN_DEPLOY=true
DEPLOY_BLOCKERS=()
if [[ -z "$ANON_KEY" ]]; then
  CAN_DEPLOY=false
  DEPLOY_BLOCKERS+=("SUPABASE_ANON_KEY")
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  CAN_DEPLOY=false
  DEPLOY_BLOCKERS+=("CLOUDFLARE_API_TOKEN")
fi
if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  CAN_DEPLOY=false
  DEPLOY_BLOCKERS+=("CLOUDFLARE_ACCOUNT_ID")
fi

if [[ "$CAN_DEPLOY" != "true" ]]; then
  yellow "    Skipping calendar deploy. Missing in .env: ${DEPLOY_BLOCKERS[*]}"
  yellow "    Add them and re-run with: DEPLOY_CALENDAR=yes ./scripts/setup.sh"
elif [[ "$DEPLOY_CAL" == "ask" ]]; then
  read -r -p "    Deploy the web calendar to Cloudflare Pages now? [Y/n] " ans
  case "$ans" in n|N|no|No|NO) DEPLOY_CAL=no ;; *) DEPLOY_CAL=yes ;; esac
fi

if [[ "$CAN_DEPLOY" == "true" && "$DEPLOY_CAL" == "yes" ]]; then
  SLUG="${CLOUDFLARE_PAGES_PROJECT:-}"
  if [[ -z "$SLUG" ]]; then
    RAND=$(openssl rand -hex 16 2>/dev/null || node -e "process.stdout.write(require('crypto').randomBytes(16).toString('hex'))")
    SLUG="cal-${RAND}"
  fi
  bold "    Cloudflare Pages project: $SLUG"

  BUILD_DIR="$(mktemp -d)"
  cp calendar-cloud/index.html "$BUILD_DIR/index.html"
  sed -i.bak \
    -e "s|REPLACE_ME_SUPABASE_URL|${SUPABASE_URL}|g" \
    -e "s|REPLACE_ME_ANON_KEY|${ANON_KEY}|g" \
    -e "s|REPLACE_ME_CALENDAR_TOKEN|${CAL_TOKEN}|g" \
    "$BUILD_DIR/index.html"
  rm -f "$BUILD_DIR/index.html.bak"

  curl -fsS -X POST "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{\"name\":\"${SLUG}\",\"production_branch\":\"main\"}" >/dev/null 2>&1 || true

  CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
  CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" \
  npx --yes wrangler@latest pages deploy "$BUILD_DIR" \
    --project-name="$SLUG" \
    --commit-dirty=true \
    --branch=main \
    >/dev/null

  rm -rf "$BUILD_DIR"
  CAL_URL="https://${SLUG}.pages.dev"

  if grep -q '^CALENDAR_BASE_URL=' .env; then
    sed -i.bak "s|^CALENDAR_BASE_URL=.*|CALENDAR_BASE_URL=https://${PROJECT_REF}.supabase.co/functions/v1/calendar|" .env
  else
    printf '\nCALENDAR_BASE_URL=https://%s.supabase.co/functions/v1/calendar\n' "$PROJECT_REF" >> .env
  fi
  rm -f .env.bak
  supabase secrets set --env-file .env --project-ref "$PROJECT_REF" >/dev/null
  supabase functions deploy telegram-webhook --no-verify-jwt --project-ref "$PROJECT_REF" >/dev/null

  green "    deployed: $CAL_URL"
fi

echo
green "Done."
echo
bold "Next:"
echo "  1. Open Telegram and message your bot. It will ask for your local time."
echo "  2. Reply with HH:MM (e.g. 08:30) and you're set."
if [[ -n "$CAL_URL" ]]; then
  echo "  3. Bookmark your calendar: $CAL_URL"
else
  echo "  3. To deploy the web calendar later, set CLOUDFLARE_API_TOKEN and"
  echo "     CLOUDFLARE_ACCOUNT_ID in .env and run:"
  echo "       DEPLOY_CALENDAR=yes ./scripts/setup.sh"
fi
echo
echo "  Like the project? https://ko-fi.com/haerincode"
