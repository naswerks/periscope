// The examples consume the package by name, which resolves through the export map to the emitted
// declarations under dist/. The type-checked lint over examples/ therefore needs a built package; without
// one every import types as an error and the rule set reports hundreds of unsafe uses that are not the
// finding. This says the one thing that is.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const emitted = fileURLToPath(new URL('../dist/protocol.d.ts', import.meta.url));
if (!existsSync(emitted)) {
  process.stderr.write(
    'lint needs a built package: dist/protocol.d.ts is absent and the examples resolve the package through it. Run npm run build first.\n',
  );
  process.exit(1);
}
