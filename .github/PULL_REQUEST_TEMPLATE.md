## What changed

<!-- One paragraph: the change and the reason. Link the issue if there is one. -->

## Checklist

- [ ] `npm test`, `npm run lint` and `npm run format:check` pass locally.
- [ ] If the wire or the public API moved: `npm run contracts:update` was run and the diff under
      `contracts/` is part of this change, read and intended.
- [ ] If the agent SDK was bumped: `npm run check:drift -- --update` was run and the type diff was read.
- [ ] No comment or test name carries an emoji, a tracking id, or a controller's vocabulary (the pins
      under `src/pins/` say so).
- [ ] `CHANGELOG.md` has an entry under `Unreleased` when the change is visible to a consumer.
