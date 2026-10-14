#!/usr/bin/env node
import { ConfigError, loadConfig } from './config.ts';

const HELP = `testscope <command> [options]

Commands:
  check-config [--config PATH]   Validate testscope.config.json
  select | run | manifest | evaluate | explain | init   (not implemented yet)
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === 'check-config') {
    const i = rest.indexOf('--config');
    try {
      await loadConfig(i >= 0 ? rest[i + 1] : undefined);
      process.stdout.write('testscope config OK\n');
      return 0;
    } catch (e) {
      if (e instanceof ConfigError) {
        process.stderr.write(`${e.message}\n`);
        return 1;
      }
      throw e;
    }
  }
  if (['select', 'run', 'manifest', 'evaluate', 'explain', 'init'].includes(cmd)) {
    process.stderr.write(`testscope ${cmd}: not implemented yet\n`);
    return 2;
  }
  process.stderr.write(HELP);
  return 1;
}

main().then((code) => {
  process.exitCode = code;
});
