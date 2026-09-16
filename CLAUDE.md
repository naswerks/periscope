# Working in this repository

Read `CONTRIBUTING.md` first; it is the contract. The short form:

- Build before anything else: `npm run build` emits `dist/`, and `npm run lint` and the examples
  typecheck read it. `npm test` is clean, build, then `node --test` over `dist/`; run it before a
  pull request.
- The pins under `src/pins/` are tests that hold the package's shape: the host boundary, the
  vocabulary, the comment style, the public API, the wire vectors. A red pin is a finding about the
  change, not about the pin; never loosen one to pass.
- After an intended change to the wire or the exported API, run `npm run contracts:update` and read
  the diff under `contracts/` before committing it. After an agent SDK bump, run
  `npm run check:drift -- --update` and read the type diff.
- Comments and test names state what the code does. No emoji, no tracking ids, no history, and none
  of a controller's vocabulary: the package speaks the agent SDK's words.
- `src/host/` is the only directory that may import `node:fs`, `node:child_process`, `node:os` or
  the agent SDK. `src/core/` imports nothing outside itself.
- A change a consumer can see gets a line under `Unreleased` in `CHANGELOG.md`.
