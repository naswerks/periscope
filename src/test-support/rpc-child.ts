/**
 * A real child process speaking line-delimited JSON-RPC, for the transport's process tests. Run with
 * `process.execPath` and one behaviour as its argument:
 * - `echo`: answers every request with `{ echo: <params> }`, and exits when stdin ends.
 * - `crash-on-request`: exits with code 3 on the first request, without answering it.
 * - `grandchild`: starts a grandchild that never exits, reports both pids as a `pids` notification,
 *   and keeps running after stdin ends, so only a tree kill ends them.
 */
import { spawn } from 'node:child_process';

const behaviour = process.argv[2] ?? 'echo';

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

if (behaviour === 'grandchild') {
  // Detached, so nothing ties its life to this process's: Node would otherwise end it with its parent
  // on Windows, and only a kill that walks the tree from the parent's pid reaches it then.
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
    detached: true,
  });
  send({ method: 'pids', params: { child: process.pid, grandchild: grandchild.pid ?? null } });
  setInterval(() => undefined, 1000);
}

let held = '';
process.stdin.on('data', (chunk: Buffer) => {
  held += chunk.toString('utf8');
  let newline = held.indexOf('\n');
  while (newline >= 0) {
    const line = held.slice(0, newline);
    held = held.slice(newline + 1);
    newline = held.indexOf('\n');
    if (line === '') continue;
    const message = JSON.parse(line) as { id?: unknown; method?: string; params?: unknown };
    if (message.id === undefined) continue;
    if (behaviour === 'crash-on-request') process.exit(3);
    send({ id: message.id, result: { echo: message.params ?? null } });
  }
});
process.stdin.on('end', () => {
  if (behaviour !== 'grandchild') process.exit(0);
});
