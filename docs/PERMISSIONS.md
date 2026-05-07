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

This is the part that makes it least-privilege. After linking, the `oracle` permission can sign `delphioracle::write` and **nothing else**.

```bash
proton account:permission:link mybp delphioracle write oracle -p mybp@active
```

Verify the link is in place:

```bash
proton account mybp
# Look for "linked_actions" under the oracle permission
```

If you later want to push to additional contracts (e.g. the native `oracles` account, or a future xpr-native delphioracle replacement), add another link — don't broaden the permission:

```bash
proton account:permission:link mybp <other-contract> <action> oracle -p mybp@active
```

## 4. Import the private key into the host's keystore

```bash
proton key:add
# paste ORACLE_PRIVATE_KEY
```

The pusher shells out to `proton action … mybp@oracle`, and the CLI looks up the matching key in its keystore. The daemon never sees the key directly.

## 5. Tighten file permissions on the keystore

The proton CLI stores keys under your home directory. Lock it down:

```bash
chmod 700 ~/.proton
```

If you're running under a dedicated `xpr-oracle` system user (recommended for systemd), make sure that user owns the keystore.

## What this protects against

| If this is compromised | … the attacker can: |
|---|---|
| `mybp@oracle` key | Push bad prices for the linked pairs. They cannot move funds, change votes, replace contracts, or change permissions. |
| The pusher daemon | At worst, push prices the same way an attacker with the key could. The daemon never holds the key. |
| The host's filesystem | They can read the encrypted keystore — recover the key if the password is weak. Use a strong proton CLI password and disk encryption. |

## Recovery

If the oracle key leaks:

```bash
# generate a fresh keypair
proton key:generate

# replace the key on the existing permission (does NOT remove the link)
proton account:permission mybp oracle NEW_PUBLIC_KEY active -p mybp@active

# update the host's keystore
proton key:remove OLD_PUBLIC_KEY
proton key:add   # paste NEW_PRIVATE_KEY
```

The `delphioracle::write` link survives because it's tied to the permission name, not the key.
