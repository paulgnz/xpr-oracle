# Least-privilege oracle permission

The pusher should sign with a key that **only** can call `delphioracle::write` — never your BP's `active` or `owner` keys. This document shows how to set that up.

> **Most BPs hold their `active` key in Anchor / Bloks / WebAuth, not in `keosd`.** This guide leads with explorer / wallet UI flows that work in any of those, with `cleos` shown as an alternative for operators who already have `active` in their local wallet.

## Goal

```
mybp@owner          (offline, never online)
   └── mybp@active  (BP operations: produce blocks, vote, claimrewards)
         └── mybp@oracle  ← lives on the pusher host, in keosd
                            permits ONLY delphioracle::write
```

## 1. Generate the oracle keypair (on the pusher host)

```bash
cleos create key --to-console
```

Output looks like:

```
Private key: PVT_K1_…
Public key:  PUB_K1_…
```

Save both. Keep the private key on this host only — never email/Slack/paste it elsewhere.

## 2. Attach the new permission to your BP account

This is an `eosio::updateauth` action authorized by `mybp@active`. Two equivalent paths.

### Via Bloks / Anchor / WebAuth (UI)

Easiest path if your `active` key lives in a wallet:

1. Go to **https://explorer.xprnetwork.org/account/eosio** → **Contract** tab → **Actions** → **`updateauth`**.
2. Fill in:
   - `account` = `mybp` (your BP account)
   - `permission` = `oracle`
   - `parent` = `active`
   - `auth` = (raw JSON, paste exactly:)
     ```json
     {
       "threshold": 1,
       "keys": [{ "key": "PUB_K1_<your-oracle-public-key>", "weight": 1 }],
       "accounts": [],
       "waits": []
     }
     ```
3. Authorization: `mybp@active`. Sign with your wallet.

### Via cleos (if `mybp@active` is in your keosd)

```bash
cleos --url http://127.0.0.1:8888 set account permission mybp oracle \
  PUB_K1_<your-oracle-public-key> active -p mybp@active
```

### Verify

```bash
curl -s https://proton.eosusa.io/v1/chain/get_account \
  -d '{"account_name":"mybp"}' \
  | jq '.permissions[] | select(.perm_name=="oracle")'
```

You should see the `oracle` permission with your public key, parented to `active`.

## 3. Link the permission to `delphioracle::write`

> **The link is mandatory.** Without it, the `oracle` permission can sign **nothing** — EOSIO contract actions default to requiring `<account>@active`, and a child permission can only satisfy actions that have been explicitly redirected to it via `linkauth`. Skipping this step leaves you with a daemon that fails every push with `missing authority of <account>/oracle`.

This is an `eosio::linkauth` action, also authorized by `mybp@active`.

### Via Bloks / Anchor / WebAuth (UI)

1. Go to **https://explorer.xprnetwork.org/account/eosio** → **Contract** tab → **Actions** → **`linkauth`**.
2. Fill in:
   - `account` = `mybp` (your BP)
   - `code` = `delphioracle`
   - `type` = `write`
   - `requirement` = `oracle`
3. Authorization: `mybp@active`. Sign.

Raw action JSON (if you need it for any other UI):

```json
{
  "account": "mybp",
  "code":    "delphioracle",
  "type":    "write",
  "requirement": "oracle"
}
```

### Via cleos

```bash
cleos --url http://127.0.0.1:8888 set action permission mybp delphioracle write oracle \
  -p mybp@active
```

### Verify the link is on-chain

```bash
curl -s https://proton.eosusa.io/v1/chain/get_account \
  -d '{"account_name":"mybp"}' \
  | jq '.permissions[] | select(.perm_name=="oracle") | .linked_actions'
```

Expected: `[ { "account": "delphioracle", "action": "write" } ]`.

If `linked_actions` is empty, the link wasn't applied — fix it before going further or every push will fail.

### Adding more linked actions later

If you later want to push to additional contracts (e.g. the Metallicus `oracles` account, or a future xpr-native delphioracle replacement), add another link — don't broaden the permission:

```bash
cleos --url http://127.0.0.1:8888 set action permission mybp <other-contract> <action> oracle \
  -p mybp@active
```

## Worked example: `protonnz`

Real two-transaction setup as it appeared on mainnet, captured directly from the chain. The `oracle` permission key (`PUB_K1_5ddxydauki57FFon5eFkAgZke5KcMGg8eFYsnfZnGnuV9Jd2Y1`) was used 6 minutes later for the [first successful self-bootstrapped push](https://explorer.xprnetwork.org/transaction/b2df49313fab7d09e14497dc4d33e9791b5e57cb0764a86d8ed9a58d99ceb800) — proving the whole chain (permission → linkauth → write) end-to-end.

### Step 1 — `eosio::updateauth` (create the permission)

- **Block:** 380882480 · **Time:** 2026-05-07 04:28:40 UTC
- **TX:** [`6a670b81…`](https://explorer.xprnetwork.org/transaction/6a670b81845d8020a1694e580ad75c59129d1fc5fa66ac1f8f1ed86ce38ee7ff)
- **Authorization:** `protonnz@active`

```json
{
  "account": "protonnz",
  "permission": "oracle",
  "parent": "active",
  "auth": {
    "threshold": 1,
    "keys": [
      { "key": "PUB_K1_5ddxydauki57FFon5eFkAgZke5KcMGg8eFYsnfZnGnuV9Jd2Y1", "weight": 1 }
    ]
  }
}
```

### Step 2 — `eosio::linkauth` (lock the permission to one action)

- **Block:** 380882571 · **Time:** 2026-05-07 04:29:25 UTC (45s after step 1)
- **TX:** [`0d6da571…`](https://explorer.xprnetwork.org/transaction/0d6da571d461903aff58d65e0abdd66c12fc461d6c604fc6db4c6044322a4fa5)
- **Authorization:** `protonnz@active`

```json
{
  "account": "protonnz",
  "code": "delphioracle",
  "type": "write",
  "requirement": "oracle"
}
```

### Step 3 — first successful `delphioracle::write` (proves the setup works)

- **Block:** ~380898553 · **Time:** 2026-05-07 06:48:06 UTC
- **TX:** [`b2df4931…`](https://explorer.xprnetwork.org/transaction/b2df49313fab7d09e14497dc4d33e9791b5e57cb0764a86d8ed9a58d99ceb800)
- **Authorization:** `protonnz@oracle` (the dedicated oracle perm — *not* active)
- **Result:** on-chain `xprusd` median changed from single-sourced (saltant=2850) to dual-sourced (median=2887, blending saltant + protonnz).

That's the success state. Your account, your txids, your timestamps will differ — but the action shapes and the verification output should match.

## 4. Import the oracle private key into your keosd wallet

The daemon shells out to `cleos push action … -p mybp@oracle`. `cleos` resolves the signature via your local `keosd` wallet, exactly like your existing `claimrewards` cron. The daemon never sees the key directly.

```bash
# create a wallet for oracle use (or reuse an existing one)
cleos --url http://127.0.0.1:8888 wallet create -n oracle --to-console

# import the oracle-permission private key
cleos --url http://127.0.0.1:8888 wallet import -n oracle
# paste ORACLE_PRIVATE_KEY when prompted
```

If you already have a wallet with all your BP keys, you can skip the `wallet create` step and `wallet import` straight into it. Set `walletName` in `config.json` if you use a non-default wallet name.

## 5. Make the wallet password available to the daemon

`cleos wallet unlock` needs the wallet password. Three clean paths — see [BP-ONBOARDING.md](BP-ONBOARDING.md) §5 for full commands.

The daemon **always** delivers the password to `cleos` via stdin, never argv — so it never appears in `ps -ef` regardless of which path you choose.

## What this protects against

| If this is compromised | … the attacker can: |
|---|---|
| `mybp@oracle` key | Push bad prices for the linked pairs. They cannot move funds, change votes, replace contracts, or change permissions. |
| The pusher daemon | At worst, push prices the same way an attacker with the wallet password could. The daemon never holds the key. |
| The host's filesystem | They can read the keosd wallet file and the password file — recover the key if filesystem permissions are loose. Use a dedicated unprivileged user, chmod 600 on secrets, and full-disk encryption. |

## Recovery

If the oracle key leaks, generate a new keypair and replace the old key on the existing permission. The `delphioracle::write` link survives because it's tied to the permission name, not the key.

### Via the explorer (UI)

Repeat §2 with the new public key — same `eosio::updateauth` action. The linkauth from §3 doesn't change.

### Via cleos

```bash
# generate a fresh keypair
cleos create key --to-console

# replace the key on the existing permission (does NOT remove the link)
cleos --url http://127.0.0.1:8888 set account permission mybp oracle \
  NEW_PUBLIC_KEY active -p mybp@active

# rotate the keosd wallet on the pusher host
cleos --url http://127.0.0.1:8888 wallet remove_key OLD_PUBLIC_KEY -n oracle --password "$(sudo cat /etc/xpr-oracle/wallet.pw)"
cleos --url http://127.0.0.1:8888 wallet import -n oracle   # paste NEW_PRIVATE_KEY
```
