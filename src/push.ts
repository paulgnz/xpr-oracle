/**
 * On-chain push via the native `cleos` CLI.
 *
 * `cleos` ships with nodeos, accepts `--url` to point at any endpoint, and
 * uses keosd for signing — exactly the pattern most XPR Network BPs already
 * run for `claimrewards` and similar scheduled actions.
 *
 * The daemon doesn't hold private keys directly: keys live in the keosd
 * wallet on the host. Optionally the daemon will unlock the wallet on each
 * tick (mirroring the typical claimrewards cron); leave `walletPasswordFile`
 * unset if you keep keosd unlocked some other way (long --unlock-timeout,
 * separate cron, etc.).
 */

import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";
import type { Config, PairConfig } from "./types.js";
import { log } from "./log.js";

const execFileP = promisify(execFile);

export interface Quote {
  /** Integer-scaled price = round(price * 10^quotedPrecision). */
  value: number;
  /** delphioracle pair name. */
  pair: string;
}

export function scalePrice(price: number, quotedPrecision: number): number {
  const scaled = Math.round(price * Math.pow(10, quotedPrecision));
  if (!Number.isSafeInteger(scaled) || scaled <= 0) {
    throw new Error(`invalid scaled value ${scaled} for price ${price}`);
  }
  return scaled;
}

export function buildQuote(pair: PairConfig, price: number): Quote {
  return { value: scalePrice(price, pair.quotedPrecision), pair: pair.name };
}

/**
 * Read the wallet password from a chmod-600 file or the env var fallback.
 * Returns null if neither is configured — the caller should then assume
 * the wallet is kept unlocked externally.
 */
function getWalletPassword(cfg: Config): string | null {
  if (cfg.walletPasswordFile) {
    let mode: number;
    try {
      mode = statSync(cfg.walletPasswordFile).mode & 0o777;
    } catch (e) {
      throw new Error(
        `cannot read walletPasswordFile ${cfg.walletPasswordFile}: ${(e as Error).message}`,
      );
    }
    const insecure = process.env.XPR_ORACLE_INSECURE_KEY === "1";
    if ((mode & 0o077) !== 0 && !insecure) {
      throw new Error(
        `walletPasswordFile ${cfg.walletPasswordFile} is too permissive ` +
          `(mode ${mode.toString(8)}). Run 'chmod 600 ${cfg.walletPasswordFile}' ` +
          `or set XPR_ORACLE_INSECURE_KEY=1 to bypass.`,
      );
    }
    return readFileSync(cfg.walletPasswordFile, "utf8").trim() || null;
  }
  return process.env.XPR_ORACLE_WALLET_PW?.trim() || null;
}

async function unlockWallet(cfg: Config, password: string): Promise<void> {
  const args = ["--url", cfg.endpoint, "wallet", "unlock", "--password", password];
  if (cfg.walletName) args.splice(2, 0, "--name", cfg.walletName);
  try {
    await execFileP("cleos", args, { timeout: 10_000 });
  } catch (e) {
    // "Already unlocked" is the happy path on subsequent ticks; everything
    // else is a real failure.
    const msg = (e as Error).message;
    if (!/already unlocked/i.test(msg)) throw e;
  }
}

/**
 * Submit `delphioracle::write` via cleos.
 * Returns the cleos stdout (transaction id summary line) on success.
 */
export async function pushQuotes(cfg: Config, quotes: Quote[]): Promise<string> {
  if (quotes.length === 0) throw new Error("no quotes to push");

  const password = getWalletPassword(cfg);
  if (password) await unlockWallet(cfg, password);

  const data = JSON.stringify({ owner: cfg.account, quotes });
  const auth = `${cfg.account}@${cfg.permission}`;
  const args = [
    "--url", cfg.endpoint,
    "push", "action",
    cfg.contract, "write",
    data,
    "-p", auth,
    "--expiration", String(cfg.expirationSeconds ?? 240),
  ];

  log.info(
    `exec: cleos --url ${cfg.endpoint} push action ${cfg.contract} write ${data} -p ${auth}`,
  );

  const { stdout, stderr } = await execFileP("cleos", args, {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });

  // cleos prints the executed transaction summary to stdout on success and
  // the assertion / auth error to stderr on failure. Surface either.
  if (!stdout && stderr) throw new Error(stderr.trim());
  return (stdout || stderr).trim();
}
