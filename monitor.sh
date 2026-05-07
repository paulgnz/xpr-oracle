#!/usr/bin/env bash
# xpr-oracle monitor — Telegram heartbeat alert
#
# Watches the daemon's heartbeat file (touched after every successful push)
# and pings a Telegram chat if the most recent successful push is older than
# MAX_AGE_MINUTES.
#
# Designed for cron. Runs every minute, spends ~1ms when healthy, fires one
# Telegram message per outage (debounced via a state file).
#
# Setup:
#   1. Create a Telegram bot via @BotFather, get the token.
#   2. Add the bot to your alerts chat (or DM it).
#   3. Get the chat_id:  curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq
#   4. Add to /etc/cron.d/xpr-oracle-monitor:
#        * * * * * xpr-oracle TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... /opt/xpr-oracle/monitor.sh
#   5. Or run as a systemd timer (preferred — see systemd/xpr-oracle-monitor.{service,timer})
#
# Env:
#   TELEGRAM_BOT_TOKEN   required — bot token from @BotFather
#   TELEGRAM_CHAT_ID     required — chat to message
#   HEARTBEAT_FILE       default: /var/lib/xpr-oracle/last-push-success
#   STATE_FILE           default: /var/lib/xpr-oracle/monitor-state
#   MAX_AGE_MINUTES      default: 15  — how stale before alerting
#   RECOVERY_NOTIFY      default: 1   — also send when oracle recovers
#   BP_NAME              default: hostname — used in the alert message

set -euo pipefail

HEARTBEAT_FILE="${HEARTBEAT_FILE:-/var/lib/xpr-oracle/last-push-success}"
STATE_FILE="${STATE_FILE:-/var/lib/xpr-oracle/monitor-state}"
MAX_AGE_MINUTES="${MAX_AGE_MINUTES:-15}"
RECOVERY_NOTIFY="${RECOVERY_NOTIFY:-1}"
BP_NAME="${BP_NAME:-$(hostname)}"

: "${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN env var}"
: "${TELEGRAM_CHAT_ID:?set TELEGRAM_CHAT_ID env var}"

now_epoch=$(date +%s)

# Determine current age of last success
if [[ -f "$HEARTBEAT_FILE" ]]; then
  last_epoch=$(stat -c %Y "$HEARTBEAT_FILE" 2>/dev/null || stat -f %m "$HEARTBEAT_FILE")
  age_sec=$(( now_epoch - last_epoch ))
else
  age_sec=999999  # never pushed
fi

age_min=$(( age_sec / 60 ))
prev_state="ok"
[[ -f "$STATE_FILE" ]] && prev_state=$(cat "$STATE_FILE" 2>/dev/null || echo ok)

send_telegram() {
  local text="$1"
  curl -fsS --max-time 10 -X POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${text}" \
    --data-urlencode "parse_mode=Markdown" >/dev/null
}

if (( age_min >= MAX_AGE_MINUTES )); then
  if [[ "$prev_state" != "alerting" ]]; then
    msg="⚠️ *xpr-oracle stale* on \`$BP_NAME\`
Last successful push: ${age_min}m ago (threshold ${MAX_AGE_MINUTES}m)
Heartbeat: \`$HEARTBEAT_FILE\`
Logs: \`journalctl -u xpr-oracle --since '1 hour ago'\`"
    send_telegram "$msg"
    echo "alerting" > "$STATE_FILE"
  fi
  exit 1
fi

# Healthy path
if [[ "$prev_state" == "alerting" && "$RECOVERY_NOTIFY" == "1" ]]; then
  msg="✅ *xpr-oracle recovered* on \`$BP_NAME\`
Last push: ${age_min}m ago"
  send_telegram "$msg"
fi
echo "ok" > "$STATE_FILE"
exit 0
