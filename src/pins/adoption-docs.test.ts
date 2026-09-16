/**
 * The adoption-doc pin: the two documents a stranger reads before installing must stay true.
 *
 * These are not style checks. Each assertion stands for a specific way the package could ship a
 * claim that is false or an omission that misleads, and prose has no compiler.
 *
 * The omission is the point, not the claim. A reader who assumes file permissions protect their
 * token on Windows has been misled by a document that simply did not mention it, and no assertion
 * about what the docs say would catch that. So specific disclosures are pinned by name.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { sourceFiles } from './walk.js';

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), 'utf8');

/**
 * Prose normalised before matching: emphasis markers, backticks and blockquote prefixes removed, and
 * all whitespace collapsed to single spaces.
 *
 * Assert the content, never the layout: a prose check that goes red when someone re-flows a
 * paragraph teaches everyone to ignore it. An underscore is stripped only where it wraps an emphasis
 * span bounded by whitespace or punctuation (the formatter writes italics as `_word_`); an underscore
 * inside an identifier (`mcp__{server}__{tool}`, `hook_timed_out`) is kept, because stripping those
 * once turned `mcp__` into `mcp`.
 */
const prose = (text: string): string =>
  text
    .replace(/^>\s?/gm, '')
    .replace(/[*`]/g, '')
    .replace(/(?<=^|[\s(])_([^_\s](?:[^_]*?[^_\s])?)_(?=$|[\s.,;:)!?])/gm, '$1')
    .replace(/\s+/g, ' ');

const security = read('SECURITY.md');
const readme = read('README.md');
const securityProse = prose(security);
const readmeProse = prose(readme);

test('the adoption documents were actually read (the positive control for everything below)', () => {
  // A failed read returning '' would make every "must not say" assertion below pass vacuously.
  assert.ok(security.length > 2_000, `SECURITY.md looks unread: ${security.length} chars`);
  assert.ok(readme.length > 2_000, `README.md looks unread: ${readme.length} chars`);
});

test('regression: SECURITY.md leads with the permission model, not with a caveat', () => {
  // The flag is judged alone otherwise. The first substantive heading has to be the thing that
  // reframes it: this replaces an interactive prompt with a stricter gate, it does not remove one.
  const firstHeading = /^##\s+(.+)$/m.exec(security)?.[1] ?? '';
  assert.match(firstHeading, /permission model/i, `SECURITY.md opens on "${firstHeading}"`);
  assert.match(securityProse, /stricter/i, 'the reframing is the whole reason to lead with it');
});

/**
 * The disclosures, as one picture. Individually each reads milder than the situation is, which is
 * why they are asserted together and why the document states them together.
 */
test('regression: SECURITY.md discloses that Windows gives the token cache no OS-level protection', () => {
  assert.match(securityProse, /no OS-level protection/i);
  assert.match(security, /\bicacls\b/, 'the rejected route is named, so the omission reads as a decision');
  assert.match(
    securityProse,
    /credential-path denial.{0,120}OS user|OS user.{0,120}credential-path denial/is,
    'the document must say what is protecting the file, not only what is not',
  );
});

test('regression: SECURITY.md keeps "cannot measure" separate from "no protection exists"', () => {
  // Collapsing them would let a Linux CI leg look like it closed both. One is an instrument gap,
  // the other a capability gap, and a Linux leg closes only the first.
  assert.match(securityProse, /different fact/i, 'the two are not distinguished in the text');
  assert.match(
    securityProse,
    /Linux CI leg closes/i,
    'the document must say what a Linux leg does and does not close, or a reader will assume it closed both',
  );
  for (const outcome of ['enforced', 'write-bit-only', 'unobservable']) {
    assert.ok(securityProse.includes(outcome), `the three-state classifier is missing "${outcome}"`);
  }
});

test("regression: SECURITY.md discloses that the gate has no opinion about an embedder's MCP tools", () => {
  assert.match(securityProse, /mcp__/, 'the tool-name shape that matches nothing is not shown');
  assert.match(securityProse, /ToolFamilies/, 'the mechanism that closes the gap is not named');
  assert.match(
    securityProse,
    /offline-provable for Bash and not for your own tools/i,
    "the consequence must be stated in the embedder's own terms",
  );
});

test('regression: SECURITY.md scopes the credential-path denial: the covered families and what falls through', () => {
  // The denial is tool-shaped and text-shaped. A reader deciding to install must meet the scope in
  // the document, not discover it in the gate's own suite: the built-in search tools sit in no
  // declared family and get no local opinion, and the shell scan matches a protected path written
  // literally.
  assert.match(securityProse, /\bGrep\b/, 'the built-in read tool that falls through is not named');
  assert.match(securityProse, /\bGlob\b/, 'the second ungated built-in read tool is not named');
  assert.match(securityProse, /symlink/i, 'the indirection the textual resolver cannot see is not named');
  assert.match(
    securityProse,
    /USERPROFILE|\$HOME/,
    'the expansion forms the literal scan misses are not named',
  );
  assert.match(
    securityProse,
    /known open question/i,
    'the widening must be stated as known and open: a silent gap reads as a missed one',
  );
  assert.match(
    securityProse,
    /controller, not this gate|controller is what stands/i,
    'the document must say what the online control over those vectors actually is',
  );
});

test('regression: SECURITY.md discloses what turning strictMcpConfig off re-admits', () => {
  assert.match(securityProse, /strictMcpConfig/);
  assert.match(
    securityProse,
    /defaults? ON|defaults to ON/i,
    'the default is what makes the absent surface harmless',
  );
  assert.match(
    securityProse,
    /re-admit/i,
    'the residual is one flag and the document must name what it lets back in',
  );
});

test('SECURITY.md carries the container lessons, each of which fails confusingly', () => {
  assert.match(security, /\broot\b/, 'the root refusal is not mentioned; every spawn fails there');
  assert.match(securityProse, /SIGTERM/, 'PID 1 gets no default signal dispositions');
  assert.match(securityProse, /CRLF/, 'a CRLF shebang fails naming the interpreter, not the line ending');
});

test('regression: SECURITY.md describes the credential that ships, the paired bearer, not only the sign-in token', () => {
  assert.match(securityProse, /paired bearer/i, 'the shipped credential is not named');
  assert.match(securityProse, /p1\.<hostId>\.<secret>/, 'the bearer shape is not shown');
  assert.match(securityProse, /paired-credential\.json/, 'where the bearer lives is not stated');
  assert.match(securityProse, /no expiry/i, 'the bearer has no clock and the document must say so');
});

test("regression: SECURITY.md states that revocation is the controller's and rotation is re-pairing", () => {
  assert.match(securityProse, /refuses the bearer at the upgrade/, 'the revocation mechanism is not named');
  assert.match(securityProse, /link-unauthorized/, 'the terminal refusal a revoked host meets is not named');
  assert.match(
    securityProse,
    /Rotation is re-pairing/i,
    'rotation must be stated as re-pairing, not left implied',
  );
});

test('regression: SECURITY.md states what a paired controller can reach on this machine', () => {
  assert.match(
    security,
    /^### What a paired controller can reach on this machine/m,
    'the reach section is missing',
  );
  assert.match(securityProse, /every transcript under the agent home/i, 'the transcript reach is not stated');
  assert.match(
    securityProse,
    /editor or a terminal/i,
    'the reach must include sessions this host did not start',
  );
  assert.match(securityProse, /repository_list/, 'the repository reach is not stated');
  assert.match(securityProse, /host_configure/, 'the write access through the configure door is not stated');
});

test('regression: the README states the one-controller, one-replica constraint', () => {
  assert.match(readme, /^## Two constraints, before you deploy/m, 'the constraints section is missing');
  assert.match(readmeProse, /One controller, one replica/, 'the replica constraint is not stated');
  assert.match(readmeProse, /gaps/, 'what a second replica would see is not stated');
});

test('regression: the README states the protocol-version handshake constraint', () => {
  assert.match(
    readmeProse,
    /protocol_version_rejected/,
    'the refusal a mismatched controller meets is not named',
  );
  assert.match(readmeProse, /retries with backoff, forever/i, 'the consequence of a mismatch is not stated');
});

test('SECURITY.md says where to report a vulnerability', () => {
  assert.match(securityProse, /security advisor/i, 'the reporting channel is not named');
});

/**
 * The ACP claim: both halves, always, and never the word "compatible".
 *
 * Credit is honest and costs a line. But no ACP client can reach this host, by design: ACP points
 * the connection inbound and Periscope dials out. Someone would try it on the strength of one
 * adjective and fail.
 */
test('regression: the ACP claim carries both halves, in every document that makes it', () => {
  for (const [name, text] of [
    ['README.md', readmeProse],
    ['SECURITY.md', securityProse],
  ] as const) {
    if (!/Agent Client Protocol|\bACP\b/.test(text)) continue;

    assert.match(text, /Agent Client Protocol/, `${name} names ACP without crediting it properly`);
    assert.match(text, /Apache-2\.0/, `${name} credits ACP without its licence`);
    assert.match(
      text,
      /not ACP compat|not be described as ACP-compat|is not an ACP implementation/i,
      `${name} makes the credit half of the ACP claim without the denial half`,
    );
  }
});

test('regression: no document claims ACP compatibility, the one adjective that would be false', () => {
  for (const [name, text] of [
    ['README.md', readmeProse],
    ['SECURITY.md', securityProse],
  ] as const) {
    // The denial sentence must itself be allowed to use the word, and only in the denial.
    const withoutDenial = text.replace(/not be described as ACP-compatible/gi, '');
    assert.doesNotMatch(
      withoutDenial,
      /\bACP[- ]compatible\b/i,
      `${name} claims ACP compatibility; no ACP client can reach this host, by design`,
    );
  }
});

test('regression: the README does not describe a built lane as unbuilt', () => {
  // The streaming section once carried a dated correction saying hook- and gate-lane transitions
  // do not reach the wire. The machine subscription carries them. The wire behavior itself is
  // pinned in the control suite; this pins the document to it.
  assert.doesNotMatch(
    readmeProse,
    /transitions to the wire is unbuilt/i,
    'the README describes the transition lane as unbuilt; the machine subscription carries it',
  );
  assert.match(
    readmeProse,
    /every state transition the machine records/i,
    'the README must state what session_update actually carries',
  );
});

test('the README answers "what versions are tested" with real numbers', () => {
  const manifest = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> };
  const sdkPin = manifest.dependencies?.['@anthropic-ai/claude-agent-sdk'] ?? '';
  const cliVersion = read('contracts/cli-version.txt').trim();

  assert.ok(
    sdkPin !== '' && readmeProse.includes(sdkPin),
    `README does not state the tested SDK version ${sdkPin}`,
  );
  assert.ok(readmeProse.includes(cliVersion), `README does not state the tested CLI version ${cliVersion}`);
  assert.match(readmeProse, /ubuntu|Linux/i, 'README does not say which platforms CI proves');
  assert.match(readmeProse, /[Ww]indows/, 'README does not say which platforms CI proves');
});

test('the README answers "why there is no permission prompt", the question SECURITY.md leads on', () => {
  assert.match(
    readmeProse,
    /does not pass --dangerously-skip-permissions/,
    'the flag is never named, so a reader who arrives with the question cannot find the answer',
  );
  assert.match(
    readmeProse,
    /PreToolUse hook[^.]*only path to a yes/,
    'the README must name the mechanism that replaces the prompt, not only deny the flag',
  );
  assert.match(
    readmeProse,
    /stricter/i,
    'the mechanism is named without the reframing, which is worse than not naming it',
  );
  assert.match(readmeProse, /SECURITY\.md/, 'the README must point at the document that states the posture');
});

test('the README documents every PERISCOPE_ variable the shipped code reads', () => {
  const read_ = new Set<string>();
  for (const file of sourceFiles()) {
    for (const match of file.text.matchAll(/\bPERISCOPE_[A-Z_]+\b/g)) read_.add(match[0]);
  }
  // Positive control: the scan saw the composition root's required variables.
  assert.ok(
    read_.has('PERISCOPE_CONTROLLER_URL') && read_.has('PERISCOPE_DECISION_URL'),
    'the variable scan is empty',
  );

  const environment = /## Environment([\s\S]*?)\n## /.exec(readme)?.[1] ?? '';
  assert.ok(environment.length > 500, 'README has no Environment section');
  const undocumented = [...read_].filter((name) => !environment.includes(`\`${name}\``)).sort();
  assert.deepEqual(
    undocumented,
    [],
    `variables the code reads but the README does not list: ${undocumented.join(', ')}`,
  );

  for (const extra of ['PERISCOPE_LIVE', 'PERISCOPE_PROOF_OUT']) {
    assert.ok(environment.includes(`\`${extra}\``), `${extra} (tests/examples only) is not listed`);
  }
});

test('the README opens with an install line that names this package', () => {
  const manifest = JSON.parse(read('package.json')) as { name: string };
  const head = readme.split('\n').slice(0, 40);
  assert.ok(
    head.includes(`npm install ${manifest.name}`),
    `the first 40 lines carry no "npm install ${manifest.name}" line`,
  );
});

test("the README's minimal controller is the example file, byte for byte", () => {
  const file = read('examples/minimal-controller/controller.ts');
  assert.ok(file.length > 500, `the example looks unread: ${file.length} chars`);
  const section = readme.split('## The minimal controller')[1] ?? '';
  const block = /```ts\n([\s\S]*?)```/.exec(section)?.[1];
  assert.ok(block !== undefined, 'the README has no ts block under "The minimal controller"');
  assert.equal(
    block,
    file,
    'the README block and examples/minimal-controller/controller.ts differ; copy the file',
  );
});

test('the README walks a reader from configuration to a running host', () => {
  assert.match(readme, /^## Point it at a controller/m, 'the walkthrough section is missing');
  assert.match(readmeProse, /periscope pair <code>/, 'the pairing command is not shown');
  assert.match(
    readmeProse,
    /\[link\] idle -> connecting \(start_requested\)/,
    'the first link line is not shown',
  );
  assert.match(readmeProse, /refuses to start/i, 'the start-up refusals are not listed');
});
