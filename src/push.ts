/**
 * On-chain push via the proton CLI.
 *
 * We deliberately use the CLI rather than @proton/js so that the daemon never
 * touches private keys directly — keys live in the proton CLI keystore on the
 * host. Make sure the host has `@proton/cli` installed and the signing key
 * loaded (see docs/PERMISSIONS.md).
 */

import { execFile } from "node:child_process";
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
 * Submit `delphioracle::write` via the proton CLI.
 * Returns the CLI stdout (transaction id line) on success.
 */
export async function pushQuotes(cfg: Config, quotes: Quote[]): Promise<string> {
  if (quotes.length === 0) throw new Error("no quotes to push");

  const data = JSON.stringify({ owner: cfg.account, quotes });
  const auth = `${cfg.account}@${cfg.permission}`;
  const args = ["action", cfg.contract, "write", data, auth];

  log.info(`exec: proton ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);

  const { stdout, stderr } = await execFileP("proton", args, {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });

  // proton CLI prints success to stdout, errors to stderr. Surface either.
  if (!stdout && stderr) throw new Error(stderr.trim());
  return (stdout || stderr).trim();
}
