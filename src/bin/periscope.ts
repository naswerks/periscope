#!/usr/bin/env node
import { readCommand } from './command.js';

// A runtime's hook runs this once per tool call, so it is dispatched before the composition root is
// loaded: the hook command imports nothing else from this package.
const argv = process.argv.slice(2);
if (readCommand(argv).kind === 'hook') {
  const { hookIo, runHook } = await import('./hook.js');
  await runHook(argv, process.env, hookIo());
} else {
  const { main, processIo } = await import('./main.js');
  void main(argv, process.env, processIo());
}
