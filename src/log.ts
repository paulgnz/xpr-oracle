/** Tiny structured-ish logger that plays nicely with journald. */

const ts = (): string => new Date().toISOString();

export const log = {
  info: (m: string, ...rest: unknown[]): void =>
    console.log(`${ts()} INFO  ${m}`, ...rest),
  warn: (m: string, ...rest: unknown[]): void =>
    console.warn(`${ts()} WARN  ${m}`, ...rest),
  error: (m: string, ...rest: unknown[]): void =>
    console.error(`${ts()} ERROR ${m}`, ...rest),
};
