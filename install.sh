#!/usr/bin/env bash
# xpr-oracle install / setup
#
# Interactive by default. Add --non-interactive (or set XPR_ORACLE_NONINTERACTIVE=1)
# plus the required flags/env vars to run unattended (suitable for agents/CI).
#
# Examples:
#   ./install.sh                              # interactive — recommended for first run
#   ./install.sh --non-interactive \
#     --account=protonnz \
#     --permission=oracle \
#     --endpoint=http://127.0.0.1:8888 \
#     --pairs=xprusd \
#     --interval=300 \
#     --wallet-password-file=/etc/xpr-oracle/wallet.pw
#
# What it does:
#   1. Checks prereqs (node ≥20, cleos, keosd, jq).
#   2. Auto-detects xpr.start install (~/xpr.start/, /opt/xpr.start/, /etc/xpr/config.ini)
#      and parses http-server-address out of nodeos config.ini.
#   3. Collects BP account, permission, endpoint, pairs, feeds, interval, password file.
#   4. Verifies on-chain: account exists, oracle permission exists, linkauth exists,
#      account is registered in delphioracle.users (warns if not).
#   5. npm install + npm run build.
#   6. Generates config.json.
#   7. Optionally installs systemd unit (--install-systemd or interactive prompt).
#   8. Prints next-step summary.
#
# Idempotent — re-running detects existing config.json and offers to update.

set -euo pipefail

#─────────────────────────────────────────────────────────────────────────────
# Constants & configuration
#─────────────────────────────────────────────────────────────────────────────

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly XPR_CHAIN_ID="384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0"

# Pair → eligible feed list. Keep this in sync with docs/FEEDS.md.
declare -A PAIR_FEEDS
PAIR_FEEDS[xprusd]="kucoin:XPR-USDT bitget:XPRUSDT mexc:XPRUSDT gate:XPR_USDT coingecko:proton"
PAIR_FEEDS[btcusd]="kucoin:BTC-USDT bitget:BTCUSDT mexc:BTCUSDT gate:BTC_USDT coinbase:BTC-USD kraken:XBTUSD bitfinex:tBTCUSD okx:BTC-USDT bybit:BTCUSDT coingecko:bitcoin"
PAIR_FEEDS[ethusd]="kucoin:ETH-USDT bitget:ETHUSDT mexc:ETHUSDT gate:ETH_USDT coinbase:ETH-USD kraken:ETHUSD bitfinex:tETHUSD okx:ETH-USDT bybit:ETHUSDT coingecko:ethereum"
PAIR_FEEDS[usdcusd]="coinbase:USDC-USD kraken:USDCUSD coingecko:usd-coin"
PAIR_FEEDS[xmdusd]="coinbase:USDC-USD kraken:USDTUSD coingecko:tether"

declare -A PAIR_PRECISION
PAIR_PRECISION[xprusd]=6
PAIR_PRECISION[btcusd]=4
PAIR_PRECISION[ethusd]=4
PAIR_PRECISION[usdcusd]=6
PAIR_PRECISION[xmdusd]=6

# Defaults. Override via flag or env var.
ACCOUNT=""
PERMISSION="oracle"
ENDPOINT=""
PUBLIC_FALLBACK="https://proton.eosusa.io"
PAIRS_CSV=""
INTERVAL=300
WALLET_PASSWORD_FILE=""
INSTALL_SYSTEMD=""
NON_INTERACTIVE="${XPR_ORACLE_NONINTERACTIVE:-}"
SKIP_BUILD=""
SKIP_CHAIN_CHECKS=""
ORACLE_PRIVATE_KEY_FILE=""
# Default to the user running install.sh. This matches field reality on most
# BP hosts, where claimrewards already runs from cron under that user and
# keosd is already unlocked there with the right keys.
RUN_USER="$(id -un)"

#─────────────────────────────────────────────────────────────────────────────
# Helpers
#─────────────────────────────────────────────────────────────────────────────

c_red()    { printf '\033[31m%s\033[0m' "$*"; }
c_green()  { printf '\033[32m%s\033[0m' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m' "$*"; }
c_blue()   { printf '\033[34m%s\033[0m' "$*"; }
c_dim()    { printf '\033[2m%s\033[0m' "$*"; }

info()  { printf '%s %s\n' "$(c_blue   '[info ]')" "$*"; }
ok()    { printf '%s %s\n' "$(c_green  '[ ok  ]')" "$*"; }
warn()  { printf '%s %s\n' "$(c_yellow '[warn ]')" "$*" >&2; }
fail()  { printf '%s %s\n' "$(c_red    '[fail ]')" "$*" >&2; exit 1; }

is_interactive() { [[ -z "$NON_INTERACTIVE" ]]; }

prompt() {
  # prompt "Question?" [default]
  local q="$1" default="${2:-}" answer=""
  if ! is_interactive; then
    [[ -n "$default" ]] && { echo "$default"; return; }
    fail "non-interactive mode but no default for: $q"
  fi
  if [[ -n "$default" ]]; then
    read -r -p "$q [$default]: " answer
    [[ -z "$answer" ]] && answer="$default"
  else
    read -r -p "$q: " answer
  fi
  echo "$answer"
}

prompt_yes_no() {
  # prompt_yes_no "Question?" "y|n"
  local q="$1" default="$2" answer
  if ! is_interactive; then
    [[ "$default" == "y" ]] && return 0 || return 1
  fi
  while true; do
    read -r -p "$q [$default]: " answer
    [[ -z "$answer" ]] && answer="$default"
    case "$answer" in
      y|Y|yes) return 0 ;;
      n|N|no)  return 1 ;;
      *) echo "Please answer y or n." ;;
    esac
  done
}

#─────────────────────────────────────────────────────────────────────────────
# Argument parsing
#─────────────────────────────────────────────────────────────────────────────

usage() {
  cat <<'EOF'
xpr-oracle installer

USAGE
  ./install.sh [flags]

FLAGS
  --account=<bp>                 BP account name (required if --non-interactive)
  --permission=<perm>            Permission name (default: oracle)
  --endpoint=<url>               nodeos URL (default: auto-detected, fallback http://127.0.0.1:8888)
  --pairs=<csv>                  Pairs to push, comma-separated. Available:
                                 xprusd, btcusd, ethusd, usdcusd, xmdusd
  --interval=<seconds>           Push interval (default: 300; min 60, max 3600)
  --wallet-password-file=<path>  chmod-600 file with the keosd wallet password
  --install-systemd              Install + enable the systemd unit
  --non-interactive              Skip all prompts (also: XPR_ORACLE_NONINTERACTIVE=1)
  --skip-build                   Skip 'npm install' and 'npm run build'
  --skip-chain-checks            Skip on-chain verification of account/permission/linkauth
  --oracle-private-key-file=<p>  Path to a file containing the oracle private key.
                                 Imported into keosd before pushing. In interactive
                                 mode, prompts for the key if not provided.
  --user=<name>                  Linux user the systemd unit runs as.
                                 Default: whoever runs install.sh. Match this to
                                 the user that already runs your claimrewards cron
                                 — that's where keosd has your keys.
  -h, --help                     This message

ENV
  XPR_ORACLE_NONINTERACTIVE=1    Same as --non-interactive
  XPR_ORACLE_WALLET_PW=<pw>      Pass wallet password directly (alternative to --wallet-password-file)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --account=*)               ACCOUNT="${1#*=}"; shift ;;
    --permission=*)            PERMISSION="${1#*=}"; shift ;;
    --endpoint=*)              ENDPOINT="${1#*=}"; shift ;;
    --pairs=*)                 PAIRS_CSV="${1#*=}"; shift ;;
    --interval=*)              INTERVAL="${1#*=}"; shift ;;
    --wallet-password-file=*)  WALLET_PASSWORD_FILE="${1#*=}"; shift ;;
    --install-systemd)         INSTALL_SYSTEMD=1; shift ;;
    --non-interactive)         NON_INTERACTIVE=1; shift ;;
    --skip-build)              SKIP_BUILD=1; shift ;;
    --skip-chain-checks)       SKIP_CHAIN_CHECKS=1; shift ;;
    --oracle-private-key-file=*) ORACLE_PRIVATE_KEY_FILE="${1#*=}"; shift ;;
    --user=*)                  RUN_USER="${1#*=}"; shift ;;
    -h|--help)                 usage; exit 0 ;;
    *) fail "unknown flag: $1 (--help for usage)" ;;
  esac
done

#─────────────────────────────────────────────────────────────────────────────
# Step 1: prereq checks
#─────────────────────────────────────────────────────────────────────────────

step_prereqs() {
  info "Checking prereqs"
  command -v node >/dev/null 2>&1 || fail "node not found in PATH (need ≥20)"
  local node_major
  node_major=$(node -e 'console.log(process.versions.node.split(".")[0])')
  [[ "$node_major" -ge 20 ]] || fail "node $node_major found, need ≥20"
  ok "node $(node --version)"

  command -v cleos >/dev/null 2>&1 || fail "cleos not found in PATH (ships with nodeos / xpr.start)"
  ok "cleos $(cleos --version 2>&1 | head -1 || echo present)"

  if ! pgrep -x keosd >/dev/null 2>&1; then
    warn "keosd is not running. Start it with:  keosd --unlock-timeout 9999999 &"
    warn "(or your normal systemd unit). Pushes will fail until keosd is up."
  else
    ok "keosd running (pid $(pgrep -x keosd | head -1))"
  fi

  if ! command -v jq >/dev/null 2>&1; then
    fail "jq not found in PATH.

Install with one of:
  sudo apt-get install -y jq          # Debian / Ubuntu
  sudo dnf install -y jq              # Fedora / RHEL
  sudo yum install -y jq              # older RHEL / CentOS
  brew install jq                     # macOS

Then re-run this script."
  fi
  ok "jq $(jq --version)"

  command -v curl >/dev/null 2>&1 || fail "curl not found in PATH"
  ok "curl present"
}

#─────────────────────────────────────────────────────────────────────────────
# Step 2: auto-detect xpr.start install + endpoint
#─────────────────────────────────────────────────────────────────────────────

detect_endpoint() {
  # If user passed --endpoint, honor it.
  [[ -n "$ENDPOINT" ]] && { ok "endpoint set via flag: $ENDPOINT"; return; }

  # Common config.ini locations from xpr.start
  local candidates=(
    "$HOME/xpr.start/config.ini"
    "/opt/xpr.start/config.ini"
    "/etc/xpr/config.ini"
    "/etc/nodeos/config.ini"
    "$HOME/.local/share/eosio/nodeos/config/config.ini"
  )
  for cfg in "${candidates[@]}"; do
    if [[ -r "$cfg" ]]; then
      local addr
      addr=$(grep -E '^\s*http-server-address\s*=' "$cfg" 2>/dev/null | head -1 | sed -E 's/.*=\s*//' | tr -d ' ')
      if [[ -n "$addr" ]]; then
        # Some configs use 0.0.0.0:8888 — point the daemon at loopback regardless
        local host="${addr%:*}" port="${addr##*:}"
        [[ "$host" == "0.0.0.0" ]] && host="127.0.0.1"
        ENDPOINT="http://${host}:${port}"
        ok "auto-detected nodeos endpoint from $cfg → $ENDPOINT"
        return
      fi
    fi
  done

  # Fall back to localhost default
  ENDPOINT="http://127.0.0.1:8888"
  warn "no xpr.start config.ini found; defaulting to $ENDPOINT"
  if is_interactive; then
    ENDPOINT=$(prompt "nodeos endpoint URL" "$ENDPOINT")
  fi
}

verify_endpoint() {
  info "Probing $ENDPOINT/v1/chain/get_info"
  local resp
  resp=$(curl -fsS --max-time 5 "$ENDPOINT/v1/chain/get_info" 2>/dev/null) || {
    warn "could not reach $ENDPOINT — daemon will fail until nodeos is up"
    return
  }
  local chain_id head_time
  chain_id=$(echo "$resp" | jq -r '.chain_id // ""')
  head_time=$(echo "$resp" | jq -r '.head_block_time // ""')
  if [[ "$chain_id" != "$XPR_CHAIN_ID" ]]; then
    warn "chain_id mismatch: $chain_id (expected $XPR_CHAIN_ID — wrong network?)"
  else
    ok "endpoint healthy, head_block_time=$head_time"
  fi
}

#─────────────────────────────────────────────────────────────────────────────
# Step 3: collect inputs
#─────────────────────────────────────────────────────────────────────────────

collect_inputs() {
  if [[ -z "$ACCOUNT" ]]; then
    if is_interactive; then
      ACCOUNT=$(prompt "BP account name (1-12 lowercase chars, a-z and 1-5)")
    else
      fail "--account is required in non-interactive mode"
    fi
  fi
  [[ "$ACCOUNT" =~ ^[a-z1-5.]{1,12}$ ]] || fail "invalid account name: $ACCOUNT"

  PERMISSION=$(prompt "Permission to sign with" "$PERMISSION")
  [[ "$PERMISSION" =~ ^[a-z1-5.]{1,12}$ ]] || fail "invalid permission name: $PERMISSION"

  if [[ -z "$WALLET_PASSWORD_FILE" && -z "${XPR_ORACLE_WALLET_PW:-}" ]]; then
    if is_interactive; then
      WALLET_PASSWORD_FILE=$(prompt "Wallet password file path" "/etc/xpr-oracle/wallet.pw")
    else
      warn "no wallet password configured (set --wallet-password-file or XPR_ORACLE_WALLET_PW)"
    fi
  fi

  # Validate / clamp interval
  [[ "$INTERVAL" =~ ^[0-9]+$ ]] || fail "interval must be a positive integer"
  [[ "$INTERVAL" -ge 60 && "$INTERVAL" -le 3600 ]] || fail "interval must be 60..3600"
  if is_interactive && [[ -z "$PAIRS_CSV" ]]; then
    INTERVAL=$(prompt "Push interval seconds (community-recommended cadence: 300)" "$INTERVAL")
    [[ "$INTERVAL" =~ ^[0-9]+$ ]] || fail "interval must be a positive integer"
  fi

  # Pairs
  if [[ -z "$PAIRS_CSV" ]]; then
    if is_interactive; then
      echo
      echo "Available pairs (currently registered on delphioracle: only xprusd):"
      echo "  1) xprusd    — XPR/USD               $(c_dim '(active on-chain)')"
      echo "  2) btcusd    — BTC/USD               $(c_dim '(not yet registered)')"
      echo "  3) ethusd    — ETH/USD               $(c_dim '(not yet registered)')"
      echo "  4) usdcusd   — USDC/USD              $(c_dim '(not yet registered)')"
      echo "  5) xmdusd    — XMD/USD (peg target)  $(c_dim '(not yet registered)')"
      echo "Enter comma-separated numbers or pair names (default: 1):"
      local raw
      raw=$(prompt "Pairs" "1")
      PAIRS_CSV=$(echo "$raw" \
        | tr ',' '\n' | tr -d ' ' \
        | sed -e 's/^1$/xprusd/' -e 's/^2$/btcusd/' -e 's/^3$/ethusd/' \
              -e 's/^4$/usdcusd/' -e 's/^5$/xmdusd/' \
        | paste -sd ',' -)
    else
      PAIRS_CSV="xprusd"
    fi
  fi

  # Validate every pair name
  IFS=',' read -ra PAIRS_ARR <<< "$PAIRS_CSV"
  for p in "${PAIRS_ARR[@]}"; do
    [[ -n "${PAIR_FEEDS[$p]:-}" ]] || fail "unknown pair: $p (known: ${!PAIR_FEEDS[*]})"
  done
  ok "pairs: ${PAIRS_ARR[*]}"
}

#─────────────────────────────────────────────────────────────────────────────
# Step 4: per-pair feed selection
#─────────────────────────────────────────────────────────────────────────────

declare -A PAIR_SELECTED_FEEDS

select_feeds_for_pair() {
  local pair="$1"
  local available=(${PAIR_FEEDS[$pair]})
  local selected_default
  case "$pair" in
    xprusd)  selected_default="kucoin:XPR-USDT,bitget:XPRUSDT,mexc:XPRUSDT,gate:XPR_USDT,coingecko:proton" ;;
    btcusd)  selected_default="kucoin:BTC-USDT,coinbase:BTC-USD,kraken:XBTUSD,bitget:BTCUSDT,coingecko:bitcoin" ;;
    ethusd)  selected_default="kucoin:ETH-USDT,coinbase:ETH-USD,kraken:ETHUSD,bitget:ETHUSDT,coingecko:ethereum" ;;
    usdcusd) selected_default="coinbase:USDC-USD,kraken:USDCUSD,coingecko:usd-coin" ;;
    xmdusd)  selected_default="coinbase:USDC-USD,kraken:USDTUSD,coingecko:tether" ;;
  esac

  if ! is_interactive; then
    PAIR_SELECTED_FEEDS[$pair]="$selected_default"
    return
  fi

  echo
  echo "Feeds eligible for $(c_blue "$pair"): ${available[*]}"
  local raw
  raw=$(prompt "Comma-separated feeds for $pair" "$selected_default")
  # Validate every entry is in the available list
  IFS=',' read -ra picks <<< "$raw"
  for f in "${picks[@]}"; do
    local found=0
    for a in "${available[@]}"; do [[ "$f" == "$a" ]] && { found=1; break; }; done
    [[ "$found" == "1" ]] || fail "feed $f is not eligible for $pair (allowed: ${available[*]})"
  done
  PAIR_SELECTED_FEEDS[$pair]="$raw"
}

#─────────────────────────────────────────────────────────────────────────────
# Step 5: on-chain verification
#─────────────────────────────────────────────────────────────────────────────

chain_check() {
  [[ -n "$SKIP_CHAIN_CHECKS" ]] && { warn "skipping on-chain checks per --skip-chain-checks"; return; }

  info "Verifying on-chain state for $ACCOUNT"

  # 1. Account exists
  local acct
  acct=$(curl -fsS --max-time 5 "$ENDPOINT/v1/chain/get_account" \
    -d "{\"account_name\":\"$ACCOUNT\"}" 2>/dev/null) \
    || { warn "could not fetch account $ACCOUNT (endpoint reachable?)"; return; }
  ok "account $ACCOUNT exists"

  # 2. Permission exists with linked_actions on delphioracle::write — REQUIRED.
  local linked
  linked=$(echo "$acct" | jq -r --arg p "$PERMISSION" \
    '.permissions[] | select(.perm_name==$p) | .linked_actions[] | select(.account=="delphioracle" and .action=="write") | .action' \
    2>/dev/null || echo "")
  if [[ -n "$linked" ]]; then
    ok "linkauth: ${ACCOUNT}@${PERMISSION} → delphioracle::write"
  else
    echo
    fail "linkauth missing: ${ACCOUNT}@${PERMISSION} → delphioracle::write is NOT on chain.

The daemon would install successfully and then fail every push with
'missing authority of ${ACCOUNT}/${PERMISSION}'. Set up the permission
first — see README.md '#One-time on-chain setup' or docs/PERMISSIONS.md.

If you've already done it in a wallet UI, the transaction may not have
landed yet — wait ~30s and re-run, or run with --skip-chain-checks to
bypass (NOT recommended; you'll have a broken daemon).

Quick on-chain verify command:
  curl -s ${ENDPOINT}/v1/chain/get_account -d '{\"account_name\":\"${ACCOUNT}\"}' \\
    | jq '.permissions[] | select(.perm_name==\"${PERMISSION}\") | .linked_actions'"
  fi

  # 3. delphioracle.users membership — informational only.
  # The contract auto-registers users on first write, so this isn't a gate;
  # we just report state so the operator knows where they stand.
  local users
  users=$(curl -fsS --max-time 5 "$ENDPOINT/v1/chain/get_table_rows" \
    -d "{\"code\":\"delphioracle\",\"scope\":\"delphioracle\",\"table\":\"users\",\"limit\":100,\"json\":true}" \
    2>/dev/null || echo '{"rows":[]}')
  if echo "$users" | jq -e --arg n "$ACCOUNT" '.rows[] | select(.name==$n)' >/dev/null 2>&1; then
    ok "$ACCOUNT is in delphioracle.users (already registered or auto-registered by a prior write)"
  else
    info "$ACCOUNT is not yet in delphioracle.users — first write will populate it automatically (no governance step required)"
  fi

  # 4. Validate selected pairs exist on-chain
  local pairs_json
  pairs_json=$(curl -fsS --max-time 5 "$ENDPOINT/v1/chain/get_table_rows" \
    -d '{"code":"delphioracle","scope":"delphioracle","table":"pairs","limit":50,"json":true}' \
    2>/dev/null || echo '{"rows":[]}')
  for p in "${PAIRS_ARR[@]}"; do
    if echo "$pairs_json" | jq -e --arg n "$p" '.rows[] | select(.name==$n and .active==1)' >/dev/null 2>&1; then
      ok "pair $p: registered + active"
    else
      warn "pair $p: not registered yet — pushes for this pair will fail"
      warn "   Ping saltant on the BP Telegram with: \"please add $p to delphioracle\""
    fi
  done
}

#─────────────────────────────────────────────────────────────────────────────
# Step 5b: import oracle private key into keosd (if not already there)
#─────────────────────────────────────────────────────────────────────────────

import_oracle_key() {
  # Inspect the keosd wallet for the oracle public key (read from get_account).
  local oracle_pub
  oracle_pub=$(curl -fsS --max-time 5 "$ENDPOINT/v1/chain/get_account" \
    -d "{\"account_name\":\"$ACCOUNT\"}" 2>/dev/null \
    | jq -r --arg p "$PERMISSION" \
        '.permissions[] | select(.perm_name==$p) | .required_auth.keys[0].key' 2>/dev/null)

  if [[ -z "$oracle_pub" || "$oracle_pub" == "null" ]]; then
    warn "could not determine the oracle public key from chain — skipping keosd import check"
    return
  fi

  # Is the key already in keosd?
  if cleos --url "$ENDPOINT" wallet keys 2>/dev/null | grep -qF "$oracle_pub"; then
    ok "oracle public key already imported in keosd: ${oracle_pub:0:24}…"
    return
  fi

  info "oracle public key (${oracle_pub:0:24}…) is NOT in keosd"

  # Source the private key from --oracle-private-key-file or interactive prompt.
  local privkey=""
  if [[ -n "$ORACLE_PRIVATE_KEY_FILE" ]]; then
    [[ -f "$ORACLE_PRIVATE_KEY_FILE" ]] || fail "oracle private key file not found: $ORACLE_PRIVATE_KEY_FILE"
    privkey=$(tr -d '[:space:]' < "$ORACLE_PRIVATE_KEY_FILE")
  elif is_interactive; then
    if prompt_yes_no "Import the oracle private key into keosd now?" "y"; then
      echo "Paste the oracle private key (PVT_K1_… or 5… legacy WIF). It is read into a temp file with chmod 600 and removed after import:"
      read -r -s privkey
      echo
    else
      warn "skipping keosd import — the daemon will fail with 'unknown key' until you run: cleos --url $ENDPOINT wallet import"
      return
    fi
  else
    fail "oracle key not in keosd and no --oracle-private-key-file provided in non-interactive mode.
Either run 'cleos --url $ENDPOINT wallet import' yourself before retrying, or pass --oracle-private-key-file=<path>."
  fi

  [[ -n "$privkey" ]] || fail "no private key provided"

  # Sanity-check the format
  case "$privkey" in
    PVT_K1_*|5[A-Za-z0-9][A-Za-z0-9]*) ;;
    *) fail "private key does not look like a WIF (expected 'PVT_K1_…' or legacy '5…' format)" ;;
  esac

  # Pipe to cleos via a tmp file (visible to the user briefly; chmod 600).
  local tmp; tmp=$(mktemp); chmod 600 "$tmp"
  printf '%s\n' "$privkey" > "$tmp"
  trap 'rm -f "$tmp"' EXIT

  local out
  if out=$(cleos --url "$ENDPOINT" wallet import --private-key "$(cat "$tmp")" 2>&1); then
    ok "imported oracle key into keosd"
  elif echo "$out" | grep -q "Key already in wallet"; then
    ok "oracle key already imported (cleos confirmed)"
  else
    rm -f "$tmp"
    fail "cleos wallet import failed: $out"
  fi

  rm -f "$tmp"
  trap - EXIT
}

#─────────────────────────────────────────────────────────────────────────────
# Step 6: build
#─────────────────────────────────────────────────────────────────────────────

build_daemon() {
  [[ -n "$SKIP_BUILD" ]] && { warn "skipping build per --skip-build"; return; }
  info "Installing daemon dependencies"
  ( cd "$SCRIPT_DIR" && npm install --silent ) || fail "npm install failed"
  ok "npm install complete"
  info "Building daemon"
  ( cd "$SCRIPT_DIR" && npm run build ) || fail "npm run build failed"
  ok "build complete: $SCRIPT_DIR/dist/index.js"
}

#─────────────────────────────────────────────────────────────────────────────
# Step 7: generate config.json
#─────────────────────────────────────────────────────────────────────────────

write_config() {
  local cfg="$SCRIPT_DIR/config.json"
  if [[ -f "$cfg" ]] && is_interactive; then
    if ! prompt_yes_no "config.json exists; overwrite?" "n"; then
      info "keeping existing config.json"
      return
    fi
  fi

  # Build pairs JSON
  local pairs_json="[]"
  for p in "${PAIRS_ARR[@]}"; do
    local feeds_json
    feeds_json=$(echo "${PAIR_SELECTED_FEEDS[$p]}" | jq -R 'split(",")')
    local entry
    entry=$(jq -n \
      --arg name "$p" \
      --argjson feeds "$feeds_json" \
      --argjson prec "${PAIR_PRECISION[$p]}" \
      '{name:$name, feeds:$feeds, quotedPrecision:$prec, maxDeviationPct:2.5, minSources:2}')
    pairs_json=$(echo "$pairs_json" | jq --argjson e "$entry" '. + [$e]')
  done

  jq -n \
    --arg account "$ACCOUNT" \
    --arg permission "$PERMISSION" \
    --arg endpoint "$ENDPOINT" \
    --argjson interval "$INTERVAL" \
    --arg pwfile "$WALLET_PASSWORD_FILE" \
    --argjson pairs "$pairs_json" \
    '{
      account: $account,
      permission: $permission,
      contract: "delphioracle",
      endpoint: $endpoint,
      intervalSeconds: $interval,
      expirationSeconds: 240
    }
    + (if $pwfile == "" then {} else {walletPasswordFile: $pwfile} end)
    + {pairs: $pairs}' > "$cfg"
  ok "wrote $cfg"
}

#─────────────────────────────────────────────────────────────────────────────
# Step 8: optional systemd install
#─────────────────────────────────────────────────────────────────────────────

install_systemd() {
  if [[ -z "$INSTALL_SYSTEMD" ]] && is_interactive; then
    if prompt_yes_no "Install systemd unit (requires sudo)?" "n"; then INSTALL_SYSTEMD=1; fi
  fi
  [[ -n "$INSTALL_SYSTEMD" ]] || { info "skipping systemd install"; return; }

  # Resolve the run-user's home directory (where keosd's wallet socket lives).
  local run_home run_group config_path
  if ! run_home=$(getent passwd "$RUN_USER" 2>/dev/null | cut -d: -f6); then
    fail "user '$RUN_USER' not found in /etc/passwd. Pass --user=<existing-user> or create the user first."
  fi
  run_group=$(id -gn "$RUN_USER")
  config_path="$SCRIPT_DIR/config.json"

  info "Installing systemd unit (sudo) — runs as $RUN_USER:$run_group"

  # Substitute the placeholders in the unit template and write to /etc/systemd/system.
  local tmp_unit
  tmp_unit=$(mktemp)
  sed -e "s|PLACEHOLDER_USER|$RUN_USER|g" \
      -e "s|PLACEHOLDER_GROUP|$run_group|g" \
      -e "s|PLACEHOLDER_WORKING_DIR|$SCRIPT_DIR|g" \
      -e "s|PLACEHOLDER_CONFIG_PATH|$config_path|g" \
      -e "s|PLACEHOLDER_HOME|$run_home|g" \
      "$SCRIPT_DIR/systemd/xpr-oracle.service" > "$tmp_unit"

  sudo cp "$tmp_unit" /etc/systemd/system/xpr-oracle.service
  sudo chmod 644 /etc/systemd/system/xpr-oracle.service
  rm -f "$tmp_unit"

  # Tighten config.json perms so keosd password isn't world-readable.
  chmod 600 "$config_path" 2>/dev/null || true

  sudo systemctl daemon-reload
  ok "systemd unit installed at /etc/systemd/system/xpr-oracle.service"
  ok "  User=$RUN_USER  WorkingDirectory=$SCRIPT_DIR  HOME=$run_home"
  ok "  Config=$config_path"
  info "Start with:  sudo systemctl enable --now xpr-oracle"
  info "Logs:        sudo journalctl -u xpr-oracle -f"
  info "Verify:      systemctl is-active xpr-oracle"
  echo
  info "Note: the daemon runs as '$RUN_USER' so it talks to that user's keosd."
  info "      Make sure keosd is up under that user (pgrep -u $RUN_USER keosd)"
  info "      and the wallet is unlocked (cleos wallet list as $RUN_USER)."
}

#─────────────────────────────────────────────────────────────────────────────
# Step 9: summary
#─────────────────────────────────────────────────────────────────────────────

summary() {
  echo
  echo "$(c_green '━━━━ install complete ━━━━')"
  echo "  account:    $ACCOUNT@$PERMISSION"
  echo "  endpoint:   $ENDPOINT"
  echo "  pairs:      ${PAIRS_ARR[*]}"
  echo "  interval:   ${INTERVAL}s"
  echo "  config:     $SCRIPT_DIR/config.json"
  echo
  echo "$(c_blue 'Next steps:')"
  echo "  1. Dry-run (fetches feeds, no on-chain push):"
  echo "       cd $SCRIPT_DIR && npm run dry-run"
  echo "  2. Live run:"
  echo "       cd $SCRIPT_DIR && npm start"
  echo "  3. (Or as a systemd unit, see docs/BP-ONBOARDING.md §7)"
  echo
  echo "$(c_dim 'docs: README.md · docs/BP-ONBOARDING.md · docs/LOCAL-NODE.md')"
}

#─────────────────────────────────────────────────────────────────────────────
# main
#─────────────────────────────────────────────────────────────────────────────

main() {
  echo "$(c_blue '╭──────────────────────────────────────────╮')"
  echo "$(c_blue '│  xpr-oracle installer · github/paulgnz   │')"
  echo "$(c_blue '╰──────────────────────────────────────────╯')"
  echo

  step_prereqs
  detect_endpoint
  verify_endpoint
  collect_inputs
  for p in "${PAIRS_ARR[@]}"; do select_feeds_for_pair "$p"; done
  chain_check        # hard-fails if linkauth is missing
  import_oracle_key  # ensures the daemon can sign before we install anything
  build_daemon
  write_config
  install_systemd
  summary
}

main "$@"
