/** Debug logger: writes timestamped phases to stderr when enabled (--debug or TESTSCOPE_DEBUG=1). */
export type Debug = (message: string) => void;

export function createDebug(
  enabled: boolean,
  write: (s: string) => unknown = (s) => process.stderr.write(s),
): Debug {
  if (!enabled) return () => {};
  const start = Date.now();
  return (message) => {
    write(`[testscope +${Date.now() - start}ms] ${message}\n`);
  };
}

export const debugEnabled = (flag?: boolean) =>
  !!flag || /^(1|true|yes)$/i.test(process.env.TESTSCOPE_DEBUG ?? '');
