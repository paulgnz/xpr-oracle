/**
 * On-chain push via the native `cleos` CLI.
 *
 * Architectural notes:
 *
 * - **Wallet password is delivered via stdin, never argv.** Passing `--password`
 *   on the cleos command line would put the keosd password in `/proc/<pid>/cmdline`,
 *   which any process with the same UID (and root, and many monitoring agents)
 *   can read. We pipe it through stdin instead — invisible to `ps -ef`.
 *
 * - **The active cleos child is tracked module-level** so a SIGINT/SIGTERM in
 *   the daemon can kill an in-flight push instead of waiting up to 30s.
 *
 * - **Errors are classified** (see `./backoff.ts`) so we don't hammer the chain
 *   with `missing authority` failures every tick when the BP isn't whitelisted yet.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import type { Config, PairConfig } from "./types.js";
import { log } from "./log.js";

export interface Quote {
  /** Integer-scaled price = round(price * 10^quotedPrecision). */
  value: number;
  /** delphioracle pair name. */
  pair: string;
}

const DEFAULT_UNLOCK_TIMEOUT_MS = 10_000;
const DEFAULT_PUSH_TIMEOUT_MS = 30_000;

// keosd error 3120007 = "Already unlocked" (per nodeos/keosd source). We match
// on the numeric code instead of the English message so locale changes or minor
// rewordings don't break the happy path.
const ALREADY_UNLOCKED_RE = /3120007|already unlocked/i;

let _activeChild: ChildProcess | null = null;

/** Kill any in-flight cleos child. Called from the daemon's signal handler. */
export function killActiveChild(): void {
  if (!_activeChild) return;
  try {
    _activeChild.kill("SIGTERM");
  } catch {
    /* already exited */
  }
  // Give it a beat, then escalate.
  setTimeout(() => {
    if (_activeChild && !_activeChild.killed) {
      try {
        _activeChild.kill("SIGKILL");
      } catch {
        /* race with natural exit */
      }
    }
  }, 2_000);
}

export function scalePrice(price: number, quotedPrecision: number): number {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`scalePrice: bad input price=${price}`);
  }
  if (!Number.isInteger(quotedPrecision) || quotedPrecision < 0 || quotedPrecision > 15) {
    // 10^15 ≈ Number.MAX_SAFE_INTEGER; beyond that f64 loses 1-unit resolution.
    throw new Error(
      `scalePrice: quotedPrecision must be 0..15 (got ${quotedPrecision}); ` +
        `for higher precision switch the daemon to BigInt encoding`,
    );
  }
  const scaled = Math.round(price * Math.pow(10, quotedPrecision));
  if (!Number.isSafeInteger(scaled) || scaled <= 0) {
    throw new Error(`scalePrice: invalid scaled value ${scaled} for price ${price}`);
  }
  return scaled;
}

export function buildQuote(pair: PairConfig, price: number): Quote {
  return { value: scalePrice(price, pair.quotedPrecision), pair: pair.name };
}

/** Read the wallet password from a chmod-600 file, or null. */
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

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `cleos` with optional stdin payload. Tracks the child globally so
 * `killActiveChild()` can interrupt it. Returns once the process exits.
 */
function runCleos(args: string[], stdin: string | null, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn("cleos", args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return reject(e);
    }
    _activeChild = child;

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
      reject(new Error(`cleos timed out after ${timeoutMs}ms: ${args.slice(0, 4).join(" ")}`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      _activeChild = null;
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return reject(
          new Error(
            "cleos not found in PATH. Install the nodeos toolchain " +
              "(https://github.com/XPRNetwork/xpr.start ships it) or set " +
              "Environment=PATH=/usr/local/bin:/usr/bin:/bin in the systemd unit.",
          ),
        );
      }
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      _activeChild = null;
      resolve({ code, stdout, stderr });
    });

    if (stdin !== null) {
      child.stdin?.write(stdin);
    }
    child.stdin?.end();
  });
}

/** Common cleos arg prefix: --url <endpoint> [--wallet-url <walletUrl>]. */
function cleosBase(cfg: Config): string[] {
  const base = ["--url", cfg.endpoint];
  if (cfg.walletUrl) base.push("--wallet-url", cfg.walletUrl);
  return base;
}

async function unlockWallet(cfg: Config, password: string): Promise<void> {
  const args = [...cleosBase(cfg), "wallet", "unlock"];
  if (cfg.walletName) args.push("--name", cfg.walletName);
  // Password on stdin — never argv.
  const r = await runCleos(args, password + "\n", DEFAULT_UNLOCK_TIMEOUT_MS);
  if (r.code === 0) return;
  if (ALREADY_UNLOCKED_RE.test(r.stderr) || ALREADY_UNLOCKED_RE.test(r.stdout)) return;
  throw new Error(
    `cleos wallet unlock exited ${r.code}: ${(r.stderr || r.stdout).trim() || "no output"}`,
  );
}

/**
 * Submit `delphioracle::write` via cleos.
 * Returns the cleos stdout transaction-summary line on success.
 */
export async function pushQuotes(cfg: Config, quotes: Quote[]): Promise<string> {
  if (quotes.length === 0) throw new Error("no quotes to push");

  const password = getWalletPassword(cfg);
  if (password) await unlockWallet(cfg, password);

  const data = JSON.stringify({ owner: cfg.account, quotes });
  const auth = `${cfg.account}@${cfg.permission}`;
  const args = [
    ...cleosBase(cfg),
    "push", "action",
    cfg.contract, "write",
    data,
    "-p", auth,
    "--expiration", String(cfg.expirationSeconds ?? 240),
  ];

  log.info(
    `exec: cleos --url ${cfg.endpoint} push action ${cfg.contract} write ${data} -p ${auth}`,
  );

  const r = await runCleos(args, null, DEFAULT_PUSH_TIMEOUT_MS);
  if (r.code === 0) {
    return (r.stdout || r.stderr).trim().split("\n")[0];
  }
  // Surface stderr (which contains the chain assertion message) so the backoff
  // classifier can pattern-match it.
  throw new Error(
    `cleos push action exited ${r.code}: ${(r.stderr || r.stdout).trim() || "no output"}`,
  );
}
