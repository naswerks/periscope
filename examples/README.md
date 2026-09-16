# Examples

Three things live here: **the smallest controller that completes a link**, **a reference
implementation of a controller**, and **a proof that this package is usable by somebody who did not
write it**, driven against a real agent.

Both consume Periscope by **package name** — `@naswerks/periscope` and `@naswerks/periscope/protocol` — through the
`exports` map, exactly as `npm install` resolves it. Not one deep relative import. A deep import
would prove the files exist; these prove the published entry points are sufficient.

## Running them

Node 22.18 or later strips types natively, so there is no build step for the examples themselves.

```
npm run build                              # the package's own dist/, which the examples import
npm run typecheck:examples
node examples/minimal-controller/controller.ts   # the two URLs a host needs, then denies every tool
node examples/test-controller/serve.ts           # the reference, with a pair code printed to redeem
node examples/parallel-run-proof/run.ts          # the proof; drives a real agent
```

`test-controller/serve.ts` is the local rehearsal of the pairing walk-through: it prints the exact
`periscope pair <code> --controller <origin>` line, and a host paired to it shows up in its log.

The proof drives a **real agent** and costs real money. `PERISCOPE_PROOF_OUT=<path>` writes the
whole run to a file.

## `minimal-controller/`

The smallest controller that completes a link: it welcomes the host, answers its heartbeat, acks
every frame and denies every tool call. The README copies it verbatim as the first thing a reader
runs; a pin keeps the two identical. It stays this small on purpose, and the reference controller
below is where every further behaviour lives.

## `test-controller/`

The reference controller, not a harness: the smallest complete other end of a host. It accepts the
outbound connection, negotiates the version, answers the heartbeat, acks every frame, answers
permission escalations over HTTP, serves a couple of tools, receives bulk posts, and renders every
frame to a log a human can read. Two things a controller in another language copies from it:

- **The doors.** `POST /asks/<kind>` for every host-scoped ask (`session_list`, `transcript_list`,
  `transcript_tail`, `workspace_list`, `workspace_release`, `workspace_release_bulk`,
  `host_configure`, `repository_list`, `repository_read`): the JSON body is the ask's members
  without `requestId`, the controller mints one, sends the ask on the host's discovery channel, and
  answers the result payload whole when the frame carrying that `requestId` arrives. An ask the codec
  refuses is answered 400 before a sequence number is spent; a host that does not answer is 504.
- **Pairing.** `POST /api/periscope/pair-codes` mints a single-use code; `POST /api/periscope/pair`
  with `{ code, machineLabel }` redeems it for `{ hostId, hostCredential, controllerUrl, decisionUrl }`,
  which is what `periscope pair <code> --controller <origin>` expects. Once a machine has paired,
  every WebSocket upgrade presents the paired bearer or is refused with 401, which the host reads as
  `link-unauthorized` and does not retry. Until one has, the door is open, because this reference
  cannot validate a sign-in token without an identity provider; a real controller does.

**It keeps one host row and the frames it saw, in memory, and no more.** No roster, no queue, no
orchestration of its own: what a session means is the embedder's. `src/host/end-to-end.test.ts`
drives every door, the pair round-trip and a host-scoped ask across a reconnect against a real host.

Its permission endpoint is typed by `DecisionRequest` and `Decision` from
`@naswerks/periscope/protocol`, the same names a controller in another language reproduces from
[the wire protocol](../docs/protocol.md).

## `parallel-run-proof/`

Drives a genuine multi-turn piece of work in a real git worktree and reports its assertions, each
of them **observed** or **`not exercised` with a reason**. Nothing in it concludes a property from
reading the code. `permission-mode-probe.ts` beside it is the receipt for what an allowed call
reaches with and without `grantOnAllow` (`SECURITY.md`, fact 5).

## What a controller provides beyond the wire

The wire is half of a controller. The other half is stated here because a first implementer meets
it only by running a host:

1. **Two transports.** Frames ride the WebSocket; a permission escalation arrives as an ordinary
   HTTP `POST` to a URL the host is configured with (`PERISCOPE_DECISION_URL`). Nothing on the wire
   announces that endpoint; [the wire protocol](../docs/protocol.md) states its request and answer.
2. **The permission types are the highest-consequence surface.** `@naswerks/periscope/protocol`
   exports `Decision`, `DecisionRequest`, `Decider` and `EscalationTransport`, so a TypeScript
   controller types its decision endpoint without the privileged entry point; a controller in
   another language reproduces the member table in the protocol document.
3. **There is no wire lane for registering an in-process tool.** Descriptors are the embedder's
   (`PeriscopeHostOptions.tools`); a controller gives a session its tools through
   `session_new.request.mcpServers`, an HTTP or stdio MCP server declaration.
4. **`escalatingDecider` is on the main entry point, not the wire subpath.** The subpath carries
   the types; the function that POSTs a decision request ships from `@naswerks/periscope`, which
   reaches the privileged module. The proof hand-writes an eight-line replacement to record what a
   controller-side implementer actually has to reproduce.
