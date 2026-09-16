// Run the reference controller as a process, so a host can be paired against it from a terminal:
// the local rehearsal of the pairing walk-through before a real controller is involved.
//
//   node examples/test-controller/serve.ts
//
// It prints the two addresses a host dials, mints one pair code and prints the exact `periscope
// pair` line that redeems it, then stays up and renders every frame it sees. Ports are ephemeral;
// re-run to get new ones. Every tool call is allowed (the default policy); pass nothing else.
import { TestController } from './controller.ts';

const controller = new TestController();
await controller.start();

const minted = await fetch(`${controller.origin}/api/periscope/pair-codes`, { method: 'POST' });
const { code } = (await minted.json()) as { code: string };

console.log(`controller link:     ${controller.controllerUrl}`);
console.log(`decision endpoint:   ${controller.decisionUrl}`);
console.log('');
console.log('pair a host with (the code is single-use and expires in ten minutes):');
console.log(`  periscope pair ${code} --controller ${controller.origin} --label rehearsal`);
console.log('then start it with `periscope` and read `periscope status`; frames render below.');
console.log('');

const stop = (): void => {
  void controller.stop().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
