# BP Onboarding

End-to-end setup for a Block Producer who wants to start providing oracle data on XPR Network. Onboarding is **self-service** — verified empirically when `protonnz` bootstrapped end-to-end on 2026-05-07. The daemon's authority is exclusively the BP's own permission and linkauth.

> Prereqs: `cleos` and `keosd` are available on the host (they ship with nodeos and are running for any BP using the standard [`xpr.start`](https://github.com/XPRNetwork/xpr.start) stack). The daemon talks to whatever URL you set as `endpoint` in `config.json`. Run on your **API node**, not your producer node — see [HOSTING.md](HOSTING.md).
>
> **The fast path is `./install.sh`** — it walks you through everything below interactively. The sections here exist for operators who want to understand what the script is doing.

---

## 1. Decide: same account or sub-account?

**Option A — Dedicated permission on your existing BP account (recommended).**
You keep one account but add a low-privilege `oracle` permission whose key only signs `delphioracle::write`. If that key is ever compromised, the blast radius is "attacker can push bad prices" — they cannot move funds, change voting, or touch the BP itself. See [PERMISSIONS.md](PERMISSIONS.md).

**Option B — Separate XPR account.**
Create a fresh account like `mybporacle`. Cleaner separation, easier to rotate, but costs you one account's RAM and a small XPR stake. Use this if you want oracle ops fully isolated from BP ops. Account creation on XPR Network typically goes through https://account.metalx.com or your existing WebAuth flow — there is no `cleos system newaccount` analogue that handles RAM/stake automatically.

For the rest of this doc, `<ACCOUNT>` = whichever account ends up signing, and `<PERM>` = `oracle` (Option A) or `active` (Option B, fine because the account does nothing else).

---

## 2. Generate and add the signing key

Generate the key **on the host that will run the pusher**. Never email/Slack/paste it elsewhere.

```bash
# generate locally
cleos create key --to-console

# import into your keosd wallet (use --name oracle if you want a dedicated wallet)
cleos --url http://127.0.0.1:8888 wallet import
# paste the private key when prompted
```

Then attach the matching public key as a permission on your BP account and link `delphioracle::write` to it. Concrete commands and the on-chain action shapes (for Anchor / Bloks / WebAuth signers) are in [PERMISSIONS.md](PERMISSIONS.md). Two transactions, ~45 seconds apart, exactly like the worked example for `protonnz`.

**Verify on-chain before continuing:**

```bash
curl -s https://proton.eosusa.io/v1/chain/get_account \
  -d '{"account_name":"<ACCOUNT>"}' \
  | jq '.permissions[] | select(.perm_name=="<PERM>") | .linked_actions'
```

Expected: `[ { "account": "delphioracle", "action": "write" } ]`. **If this is empty, every push will fail with `missing authority`.**

---

## 3. Register yourself with `delphioracle::reguser` (1 transaction, 30 seconds)

The contract's `write` action checks the on-chain `linkauth` from §2 — once that's in place, you can push (verified empirically by `protonnz` on 2026-05-07, [tx `b2df4931…`](https://explorer.xprnetwork.org/transaction/b2df49313fab7d09e14497dc4d33e9791b5e57cb0764a86d8ed9a58d99ceb800)).

You should still call `reguser` once to put yourself in the `users` table cleanly. It's free, takes one transaction, and you sign it with your **own** active key.

### Easiest: via the explorer UI (if your active key is in Anchor/Bloks/WebAuth)

Most BPs hold their `active` key in a wallet, not in `cleos`. Use the explorer:

1. Go to **https://explorer.xprnetwork.org/account/delphioracle**
2. Click the **Contract** tab → **Actions** → **`reguser`**
3. Fill in `owner` = your BP account name (e.g. `protonnz`)
4. Sign the transaction with your wallet (Anchor / Bloks / WebAuth — same wallet you use for `claimrewards`)

That's it. You're registered.

### Alternative: via `cleos` (if your active key is already in `keosd`)

```bash
cleos --url http://127.0.0.1:8888 push action delphioracle reguser \
  '{"owner":"<ACCOUNT>"}' \
  -p <ACCOUNT>@active
```

### Verify

```bash
curl -s https://proton.eosusa.io/v1/chain/get_table_rows \
  -d '{"code":"delphioracle","scope":"delphioracle","table":"users","limit":50,"json":true}' \
  | jq '.rows[] | select(.name=="<ACCOUNT>")'
```

You should see one row with your account name and `score: 0`. Score doesn't gate writes — saltant has been pushing for over a year with score 0.

### The one governance step that still applies

**Adding a new pair** (e.g. `btcusd`, `ethusd`) requires `newbounty`/`editbounty`/`editpair` actions which need saltant's auth or a BP multisig. That only matters if you want to push pairs that aren't already registered. As of 2026-05-07 only `xprusd` is registered. See [GOVERNANCE.md](GOVERNANCE.md).

---

## 4. Configure the pusher

```bash
git clone https://github.com/paulgnz/xpr-oracle && cd xpr-oracle

# the easy way
./install.sh

# or by hand:
npm install
npm run build
cp config.example.json config.json
$EDITOR config.json
```

Minimum config:

```json
{
  "account": "<ACCOUNT>",
  "permission": "<PERM>",
  "contract": "delphioracle",
  "endpoint": "http://127.0.0.1:8888",
  "intervalSeconds": 300,
  "walletPasswordFile": "/etc/xpr-oracle/wallet.pw",
  "pairs": [
    {
      "name": "xprusd",
      "feeds": ["kucoin:XPR-USDT", "bitget:XPRUSDT", "mexc:XPRUSDT", "gate:XPR_USDT", "coingecko:proton"],
      "quotedPrecision": 6,
      "maxDeviationPct": 2.5,
      "minSources": 2
    }
  ]
}
```

> **Match `quotedPrecision` to the on-chain pair.** For `xprusd` it's 6. Wrong precision = 1000× off-chain median = your submissions get filtered out as outliers, or worse, accepted and pollute the feed.

---

## 5. Wallet password handling

`cleos wallet unlock` needs the wallet password. Three options:

**Recommended — chmod-600 file:**

```bash
sudo mkdir -p /etc/xpr-oracle
sudo install -m 0600 /dev/null /etc/xpr-oracle/wallet.pw
echo 'PW5K…your wallet password…' | sudo tee /etc/xpr-oracle/wallet.pw
```

Reference it as `walletPasswordFile` in `config.json`. The daemon reads it before every push (so password rotation works without restart) and refuses to start if the file mode permits group/world reads.

**Env var:** add `Environment=XPR_ORACLE_WALLET_PW=…` to the systemd unit. Slightly worse (visible in `/proc/<pid>/environ` and `systemctl show`), but works.

**External keosd unlock:** run `keosd --unlock-timeout 9999999` and unlock once at boot via a separate mechanism. Leave `walletPasswordFile` and the env var unset; the daemon skips the unlock step.

The daemon **always** delivers the password to cleos via stdin, never argv — so it's invisible in `ps -ef` regardless of which path you choose.

---

## 6. Dry run

```bash
npm run dry-run
```

Confirm logs show all your feeds returning sane prices and the median lines up with what you see on the exchanges. Let it run for an hour. If it's noisy, tighten `maxDeviationPct` or drop unreliable feeds.

---

## 7. Live test push

```bash
npm start
```

Watch the first few cycles. You should see `push ok: <txid>` lines. Look the txids up on https://explorer.xprnetwork.org/account/delphioracle.

If your first push fails:

| Error | Fix |
|---|---|
| `missing authority of <ACCOUNT>/oracle` | Linkauth not in place — recheck §2. |
| `expired_tx_exception` | Your local nodeos is lagging — check head_block_time freshness. |
| `assertion failure with message: …` | Open an issue with the full message; Atomic Assets API checks may have changed. |

---

## 8. Production install (systemd)

> **Before `systemctl enable --now`, confirm the linkauth is on-chain** (§2 verify command). If you skipped that, every push will fail with `missing authority`.

`./install.sh --install-systemd` does all of this. By hand:

```bash
# system user, no shell
sudo useradd --system --home /var/lib/xpr-oracle --create-home --shell /usr/sbin/nologin xpr-oracle

# code + config
sudo mkdir -p /opt/xpr-oracle /etc/xpr-oracle
sudo cp -r dist package.json /opt/xpr-oracle/
sudo cp config.json /etc/xpr-oracle/config.json
sudo chown -R xpr-oracle:xpr-oracle /opt/xpr-oracle /etc/xpr-oracle /var/lib/xpr-oracle
sudo chmod 600 /etc/xpr-oracle/config.json

# wallet password file (chmod 600, owned by the service user)
sudo install -m 0600 -o xpr-oracle -g xpr-oracle /dev/null /etc/xpr-oracle/wallet.pw
echo 'PW5K…your wallet password…' | sudo tee /etc/xpr-oracle/wallet.pw

# import the oracle key into the keosd wallet on this host (if not done in §2)
cleos --url http://127.0.0.1:8888 wallet import   # paste the oracle private key

# install the unit
sudo cp systemd/xpr-oracle.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xpr-oracle
sudo journalctl -u xpr-oracle -f
```

If your BP node uses nvm/fnm, fix `ExecStart` in the unit file to point at the right `node` binary.

---

## 9. Monitor

Minimum viable monitoring:

- `journalctl -u xpr-oracle -f` for live logs.
- Alert on the unit being inactive: `systemctl is-active xpr-oracle`.
- **Heartbeat freshness via Telegram** — set `heartbeatFile` in config, then run `monitor.sh` from cron with your bot token. See the script's header comment.
- Verify pushes are landing on-chain at https://explorer.xprnetwork.org/account/delphioracle.

---

## 10. Rotate keys periodically

Generate a new oracle keypair, attach it to your `oracle` permission alongside the old one, swap it in on the host, then drop the old key from the permission. The `delphioracle::write` linkauth survives because it's tied to the permission name, not the key. Concrete commands in [PERMISSIONS.md](PERMISSIONS.md) §Recovery.
