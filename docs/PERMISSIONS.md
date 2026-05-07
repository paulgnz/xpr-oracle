# Least-privilege oracle permission

The pusher should sign with a key that **only** can call `delphioracle::write` — never your BP's `active` or `owner` keys. This document shows how to set that up using the `proton` CLI.

## Goal

```
mybp@owner          (offline, multisig, never online)
   └── mybp@active  (BP operations: produce blocks, vote, etc.)
         └── mybp@oracle  ← lives on the pusher host
                            permits ONLY delphioracle::write
```

## 1. Generate the oracle keypair

On the host that will run the pusher:

```bash
proton key:generate
# → writes a (publicKey, privateKey) pair to stdout
```

Save the public key. Keep the private key on this host only.

## 2. Attach the permission to your BP account

The permission's parent is `active`, so `active` can update or remove it later. Threshold 1, single key.

```bash
proton account:permission mybp oracle ORACLE_PUBLIC_KEY active -p mybp@active
```

Verify:

```bash
proton account mybp
```

You should see `oracle` listed under permissions, parented to `active`.

## 3. Link the permission to the action

> **The link is mandatory, not optional.** Without it, the `oracle` permission can sign **nothing at all** — EOSIO contract actions default to requiring `<account>@active`, and a child permission can only satisfy actions that have been explicitly redirected to it via `linkauth`. Skipping this step leaves you with a daemon that fails every push with `missing authority of <account>/oracle`.

After linking, the `oracle` permission can sign `delphioracle::write` and **nothing else**.

### Via the proton CLI

```bash
proton account:permission:link mybp delphioracle write oracle -p mybp@active
```

### Via Anchor / Bloks / WebAuth (raw action)

If your `active` permission lives in a wallet that signs through an explorer, propose this `eosio::linkauth` action authorized by `mybp@active`:

```json
{
  "account": "mybp",
  "code":    "delphioracle",
  "type":    "write",
  "requirement": "oracle"
}
```

### Verify the link is on-chain

Linkauth records are a native chain object, **not** a contract table — `get_table_rows code=eosio table=permlink` returns empty regardless. Use one of these instead.

**Option 1: chain RPC `get_account`** — official, works on any node. Look at `permissions[].linked_actions[]` on the `oracle` permission:

```bash
curl -s https://proton.eosusa.io/v1/chain/get_account \
  -d '{"account_name":"mybp"}' \
  | jq '.permissions[] | select(.perm_name=="oracle") | .linked_actions'
```

Expected output:

```json
[ { "account": "delphioracle", "action": "write" } ]
```

**Option 2: Hyperion `/v2/state/get_links`** — same data plus the block/timestamp when the link was created:

```bash
curl -s "https://proton.eosusa.io/v2/state/get_links?account=mybp" | jq '.links'
```

**Option 3: explorer UI** — https://explorer.xprnetwork.org/account/mybp shows the permission tree with each linked action labeled. Useful as a screenshot for your whitelist request.

If `linked_actions` is empty (or `links` doesn't include `delphioracle::write`), the link wasn't applied — fix it before going further or every push will fail.

## Worked example: `protonnz`

Real two-transaction setup as it appeared on mainnet, captured directly from the chain. Use this as a copy-paste reference for what each step looks like on-chain — particularly useful if you're signing through Anchor / Bloks / WebAuth instead of the proton CLI.

### Step 1 — `eosio::updateauth` (create the permission)

- **Block:** 380882480 · **Time:** 2026-05-07 04:28:40 UTC
- **TX:** [`6a670b81845d8020a1694e580ad75c59129d1fc5fa66ac1f8f1ed86ce38ee7ff`](https://explorer.xprnetwork.org/transaction/6a670b81845d8020a1694e580ad75c59129d1fc5fa66ac1f8f1ed86ce38ee7ff)
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
- **TX:** [`0d6da571d461903aff58d65e0abdd66c12fc461d6c604fc6db4c6044322a4fa5`](https://explorer.xprnetwork.org/transaction/0d6da571d461903aff58d65e0abdd66c12fc461d6c604fc6db4c6044322a4fa5)
- **Authorization:** `protonnz@active`

```json
{
  "account": "protonnz",
  "code": "delphioracle",
  "type": "write",
  "requirement": "oracle"
}
```

### Verify it took

```bash
curl -s https://proton.eosusa.io/v1/chain/get_account \
  -d '{"account_name":"protonnz"}' \
  | jq '.permissions[] | select(.perm_name=="oracle") | .linked_actions'
```

```json
[ { "account": "delphioracle", "action": "write" } ]
```

That's the success state. Your account, your txids, your timestamps will differ — but the action shapes and the verification output should match.

### Adding more linked actions later

If you later want to push to additional contracts (e.g. the native `oracles` account, or a future xpr-native delphioracle replacement), add another link — don't broaden the permission:

```bash
proton account:permission:link mybp <other-contract> <action> oracle -p mybp@active
```

## 4. Import the private key into your keosd wallet

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

`cleos wallet unlock` needs the wallet password. Two clean paths:

**Path A — chmod-600 file (recommended):**

```bash
sudo mkdir -p /etc/xpr-oracle
sudo install -m 0600 /dev/null /etc/xpr-oracle/wallet.pw
echo 'PW5K…your wallet password…' | sudo tee /etc/xpr-oracle/wallet.pw
sudo chown xpr-oracle:xpr-oracle /etc/xpr-oracle/wallet.pw
```

Then in `config.json`:

```json
{ "walletPasswordFile": "/etc/xpr-oracle/wallet.pw" }
```

**Path B — environment variable:**

In `xpr-oracle.service` add `Environment=XPR_ORACLE_WALLET_PW=PW5K…`. Slightly worse because env vars are visible in `/proc/<pid>/environ` and `systemctl show`, but it's how a lot of BP automation works.

**Path C — keep the wallet unlocked externally:**

Run `keosd --unlock-timeout 9999999` (or via systemd) and unlock it once at boot with a separate mechanism. Leave both `walletPasswordFile` and the env var unset; the daemon will skip the unlock step. Useful if you want all wallet handling outside the oracle daemon.

## What this protects against

| If this is compromised | … the attacker can: |
|---|---|
| `mybp@oracle` key | Push bad prices for the linked pairs. They cannot move funds, change votes, replace contracts, or change permissions. |
| The pusher daemon | At worst, push prices the same way an attacker with the wallet password could. The daemon never holds the key. |
| The host's filesystem | They can read the keosd wallet file and the password file — recover the key if filesystem permissions are loose. Use a dedicated unprivileged user, chmod 600 on secrets, and full-disk encryption. |

## Recovery

If the oracle key leaks:

```bash
# generate a fresh keypair (any tool that produces an EOSIO/Antelope keypair works)
cleos create key --to-console

# replace the key on the existing permission (does NOT remove the link)
cleos --url http://127.0.0.1:8888 set account permission mybp oracle \
  NEW_PUBLIC_KEY active -p mybp@active

# rotate the keosd wallet
cleos --url http://127.0.0.1:8888 wallet remove_key OLD_PUBLIC_KEY -n oracle --password $WALLET_PW
cleos --url http://127.0.0.1:8888 wallet import -n oracle   # paste NEW_PRIVATE_KEY
```

The `delphioracle::write` link survives because it's tied to the permission name, not the key.
