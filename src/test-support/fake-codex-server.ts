/**
 * The fake app-server as a real process, for the tests that run the npm launcher path: run as
 * `process.execPath fake-codex-server.js ...`, with its options as JSON in `PERISCOPE_FAKE_CODEX`.
 *
 * `--version` prints `codex-cli <version>` and exits, as the real binary does; any other command line
 * that names `app-server` serves line-delimited JSON on stdio until stdin ends. The arguments it was
 * started with are written to stderr, one line, so a test can read them.
 */
import { FakeCodexServer } from './fake-codex.js';
import type { FakeCodexOptions } from './fake-codex.js';

const options = JSON.parse(process.env['PERISCOPE_FAKE_CODEX'] ?? '{}') as FakeCodexOptions & {
  readonly versionLine?: string;
};
const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write(`${options.versionLine ?? `codex-cli ${options.version ?? '0.162.1'}`}\n`);
  process.exit(0);
}

process.stderr.write(`argv ${JSON.stringify(args)} home ${process.env['CODEX_HOME'] ?? ''}\n`);
const server = new FakeCodexServer(
  { ...options, codexHome: options.codexHome ?? process.env['CODEX_HOME'] ?? '' },
  process.cwd(),
  (line) => process.stdout.write(line),
);

let held = '';
process.stdin.on('data', (chunk: Buffer) => {
  held += chunk.toString('utf8');
  let newline = held.indexOf('\n');
  while (newline >= 0) {
    const line = held.slice(0, newline);
    held = held.slice(newline + 1);
    newline = held.indexOf('\n');
    if (line.trim() !== '') server.receive(JSON.parse(line) as never);
  }
});
process.stdin.on('end', () => process.exit(0));
