# BP Onboarding

End-to-end setup for a Block Producer who wants to start providing oracle data on XPR Network.

> All commands assume `@proton/cli` installed (`npm i -g @proton/cli`) and `proton chain:set proton` already run.

---

## 1. Decide: same account or sub-account?

You have two options for the signing identity. Either is fine; pick what fits your ops model.

**Option A — Dedicated permission on your existing BP account (recommended).**
You keep one account but add a low-privilege `oracle` permission whose key only signs `delphioracle::write`. If that key is ever compromised, the blast radius is "attacker can push bad prices" — they cannot move funds, change voting, or touch the BP itself. See [PERMISSIONS.md](PERMISSIONS.md).

**Option B — Separate XPR account.**
Create a fresh account like `mybporacle`. Cleaner separation, easier to rotate, but costs you one account's RAM and a small XPR stake. Use this if you want oracle ops fully isolated from BP ops.

```bash
# Option B: create the dedicated account (replace placeholders)
proton account:create mybporacle EOS_PUBLIC_KEY EOS_PUBLIC_KEY -c mybp
```

For the rest of this doc, `<ACCOUNT>` = whichever account ends up signing, and `<PERM>` = `oracle` (Option A) or `active` (Option B, fine because the account does nothing else).

---

## 2. Generate and add the signing key

Generate the key **on the host that will run the pusher**. Never email/Slack/paste it elsewhere.

```bash
# generate locally
proton key:generate

# import to the proton CLI keystore on this host
proton key:add
# paste the private key when prompted
```

If using **Option A**, attach the matching public key as a new `oracle` permission (see [PERMISSIONS.md](PERMISSIONS.md)).

---

## 3. Request whitelisting on `delphioracle`

The on-chain `delphioracle` contract on XPR Network is governed by the BP multisig (`eosio.prods@active` is in its `active` permission). To start submitting prices, your account needs to be approved as an oracle producer for the pair(s) you want to push.

There is no fully self-service "apply" action in the deployed contract today, so the process is:

### 3a. Open a request

Open a PR or issue on this repository (or wherever your community tracks oracle ops) including:

- BP account name being whitelisted
- Permission you'll sign with (e.g. `mybp@oracle`)
- Pairs you intend to push (e.g. `xprusd`)
- Push interval and CEX sources
- Public key for the oracle permission
- Confirmation you've run `npm run dry-run` cleanly for ≥24h

### 3b. BP multisig approval

A coordinating BP proposes the on-chain action that adds you. Because `delphioracle@active` includes `eosio.prods@active`, this needs **15-of-21 BPs** to approve.

The proposing BP runs (concrete action depends on the contract path used to register oracles — see [GOVERNANCE.md](GOVERNANCE.md) for current options and exact JSON):

```bash
# Example shape — adapt to whichever delphioracle action governs oracle approval
proton multisig:propose addOracleRequest123 \
  '[{"actor":"eosio.prods","permission":"active"}]' \
  '[{"actor":"<delphioracle-action-actor>","permission":"<perm>"}]' \
  delphioracle <action> '<json-data>'
```

Other BPs review and approve:

```bash
proton multisig:approve <proposer> addOracleRequest123 \
  '{"actor":"<bp-account>","permission":"active"}'
```

Once threshold is hit, anyone can execute:

```bash
proton multisig:exec <proposer> addOracleRequest123 <executor>
```

### 3c. Verify approval

```bash
proton table delphioracle delphioracle producers   # may require ABI; see notes
proton table delphioracle delphioracle users
```

If `proton table` rejects the table due to ABI gaps, query via raw RPC:

```bash
curl -s https://proton.eosusa.io/v1/chain/get_table_rows \
  -d '{"code":"delphioracle","scope":"delphioracle","table":"producers","limit":50,"json":true}'
```

You can also just **try a write** — if you're not whitelisted, the action fails with a clear assertion.

---

## 4. Configure the pusher

```bash
git clone https://github.com/paulgnz/xpr-oracle && cd xpr-oracle
npm install
npm run build
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "account": "<ACCOUNT>",
  "permission": "<PERM>",
  "contract": "delphioracle",
  "intervalSeconds": 60,
  "pairs": [
    {
      "name": "xprusd",
      "feeds": ["kucoin:XPR-USDT", "bitget:XPRUSDT"],
      "quotedPrecision": 6,
      "maxDeviationPct": 2.5,
      "minSources": 2
    }
  ]
}
```

> **Match `quotedPrecision` to the on-chain pair.** For `xprusd` it's 6. Wrong precision = 1000× off-chain median = your submissions get filtered out as outliers, or worse, accepted and pollute the feed.

---

## 5. Dry run

```bash
npm run dry-run
```

Confirm logs show all your feeds returning sane prices and the median lines up with what you see on the exchanges. Let it run for an hour. If it's noisy, tighten `maxDeviationPct` or drop unreliable feeds.

---

## 6. Live test push

Before approval comes through, you can verify your CLI auth works against a harmless action (e.g. a self-transfer of 0.0001 XPR). After approval:

```bash
npm start
```

Watch the first few cycles. You should see `push ok: <txid>` lines. Look the txids up on https://explorer.xprnetwork.org.

---

## 7. Production install (systemd)

```bash
# system user, no shell
sudo useradd --system --home /var/lib/xpr-oracle --create-home --shell /usr/sbin/nologin xpr-oracle

# code + config
sudo mkdir -p /opt/xpr-oracle /etc/xpr-oracle
sudo cp -r dist package.json node_modules /opt/xpr-oracle/
sudo cp config.json /etc/xpr-oracle/config.json
sudo chown -R xpr-oracle:xpr-oracle /opt/xpr-oracle /etc/xpr-oracle /var/lib/xpr-oracle
sudo chmod 600 /etc/xpr-oracle/config.json

# proton CLI keystore for the service user
sudo -u xpr-oracle -H bash -c 'proton chain:set proton && proton key:add'

# install the unit
sudo cp systemd/xpr-oracle.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xpr-oracle
sudo journalctl -u xpr-oracle -f
```

If your BP node uses nvm/fnm, fix `ExecStart` in the unit file to point at the right `node` binary.

---

## 8. Monitor

Minimum viable monitoring:

- `journalctl -u xpr-oracle -f` for live logs.
- Alert on the unit being inactive: `systemctl is-active xpr-oracle`.
- Alert on freshness — a separate cron that queries `delphioracle::datapoints` and pages you if your account hasn't pushed in N minutes.

---

## 9. Rotate keys periodically

Generate a new oracle keypair, attach it to your `oracle` permission alongside the old one (raise threshold momentarily if needed), swap it in on the host, then drop the old key from the permission. This keeps continuity while replacing the on-disk secret.
