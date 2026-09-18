/**
 * The closed vocabulary of reasons this package refuses something.
 *
 * A degrade is a named outcome. Nothing here returns a bare `false`, an empty string, or a silent
 * skip: a caller that cannot proceed learns which of these it hit, and the set is closed so a
 * reader can enumerate every way a call can fail without reading every call site.
 */
export const REFUSAL_REASONS = [
  // Codec — the wire edge.
  'frame-not-json',
  'frame-malformed',
  'frame-too-large',

  // Sequencing.
  'seq-gap',
  'seq-regressed',

  // The outbound link.
  //   link-write-deferred  The controller's own send outcome: the frame was validated,
  //                        minted its seq and is retained, but the socket write did not land
  //                        (closed, or faulted mid-write); the reconnect replay delivers it. It is
  //                        not `link-send-failed`: that means never-queued, nothing coming. The
  //                        split exists so that neither is reported as success on the controller
  //                        (bytes that went nowhere, a caller told "sent"). Never emitted by this
  //                        host; declared here because the vocabulary is shared.
  //   link-unauthorized    The controller refused this host's identity at the door: the
  //                        WebSocket upgrade answered 401 or 403, so no socket ever opened. It is
  //                        not `link-send-failed`: that names a transport that faltered, and this
  //                        transport worked perfectly while the peer said no. The token layer's own
  //                        split (`token-grant-rejected`) cannot see this one, because the material
  //                        was minted fine and refused later, at the controller; a revoked or
  //                        mis-scoped credential presents exactly here. Terminal by predicate
  //                        (see `needsHumanReauthentication`): redialling a door that has refused
  //                        the identity is a loop with no exit. Sign in again.
  'link-not-open',
  'link-closed',
  'link-send-failed',
  'link-unauthorized',
  'link-write-deferred',

  // The offline queue.
  //   retention-released-unacked  An ended session's written frames, released because the hold
  //                               outlived its bound, never because they were acked. It is not
  //                               `queue-dropped-droppable`: that names a delta discarded before it
  //                               was numbered, which the wire never misses. These are stamped,
  //                               undroppable frames a controller could still have asked for, so
  //                               losing them is a real loss and it says so. Named rather than
  //                               silent, because "the host released them" and "they were never
  //                               sent" are indistinguishable from the outside and only one of them
  //                               is something to investigate.
  'queue-dropped-droppable',
  'queue-overflow-undroppable',
  'retention-released-unacked',

  // No credential configured. The link connects without a header in that case (see `link.ts`).
  'credential-unavailable',

  // Sessions. Three reasons, and they must not be collapsed into one: they are three different
  // kinds of failure and only the caller can decide what to do about each.
  //   session-unknown       a caller error: an id this registry does not hold. Retrying is futile.
  //   session-spawn-failed  an outage: the agent process did not come up. Retrying may work.
  //   workspace-untrusted   a degrade: the work proceeds, but settings-file rules are silently
  //                         void, so anything depending on them is not in force.
  // Merging them would let an outage arrive wearing a refusal's clothes and impersonate a
  // deliberate "no".
  'session-unknown',
  'session-spawn-failed',
  'workspace-untrusted',
  //   session-cap-reached   the host's session bound: a session_new past PeriscopeHostOptions.maxSessions
  //                         is refused before anything is reserved. Not session-spawn-failed: nothing
  //                         was tried, and retrying after another session ends is the remedy.
  //   prompt-queue-full     a session_prompt past the live session's pending-turn bound. The turn was
  //                         not taken; the session is fine. A peer that keeps sending past this is the
  //                         unbounded buffer this package refuses everywhere else.
  //   env-key-refused       a session_new whose extraEnv names a key beneath the host's floor (PATH,
  //                         NODE_OPTIONS and the like): refused before a process exists. The floor is
  //                         the embedder's to widen; the binary never does.
  'session-cap-reached',
  'prompt-queue-full',
  'env-key-refused',

  // The declared state model. A transition that cannot name what caused it is refused rather than
  // recorded, because a state nobody can explain is worse than no state at all: it reads as fact.
  'transition-cause-unnamed',

  // The permission decision. Two reasons, and they must not be collapsed into one; neither is a
  // denial, which is a deliberate answer and carries `cause.kind:'control'` instead.
  //   permission-decision-unavailable    an outage: the decider threw, the escalation transport
  //                                      failed, or the controller answered non-2xx. Nobody decided.
  //   permission-decision-unrecognised   a decision value this build has never seen: a controller
  //                                      running ahead of a host, a new tier, a rolled-back deploy.
  // An outage is an infrastructure fix and an unrecognised value is a controller-version fix, so
  // telling them apart is the difference between two different investigations. Both block the tool.
  //   permission-grant-shadows-settings  A composition this package will not assemble, refused
  //                                      before any session exists. The gate can make its allow
  //                                      effective (see `grantOnAllow` in gate/gate.ts), but an
  //                                      effective allow short-circuits every permission check that
  //                                      runs after it, and when settings files are loaded those
  //                                      checks include the operator's own deny rules. The two are
  //                                      individually reasonable and jointly mean "the gate silently
  //                                      overrides rules the operator wrote". Refused by name rather
  //                                      than resolved by precedence, because either precedence is a
  //                                      surprise to somebody.
  //   gate-deadlines-inverted            The second composition this package will not assemble,
  //                                      reachable from off-box because gate timings ride
  //                                      `session_new`. `permissionHooks` throws at construction
  //                                      when the host's own deadline does not expire before the
  //                                      matcher's (correct, deliberate, and pinned, because a
  //                                      matcher expiring first blocks the tool with nothing
  //                                      recorded and reads as a hang). But a throw escaping the
  //                                      payload dispatcher is a command that vanishes, which reads
  //                                      to a controller as a host that hung: the exact failure the
  //                                      dispatcher refuses everything by name to avoid. So the
  //                                      throw stays where an embedder meets it and the composer
  //                                      converts it into this named refusal, before any process
  //                                      exists.
  'permission-decision-unavailable',
  'permission-decision-unrecognised',
  'permission-grant-shadows-settings',
  'gate-deadlines-inverted',

  // The bulk lane.
  //
  // `bulk-target-not-controller` is a separate reason from `bulk-target-invalid`, deliberately.
  // A malformed or wrong-scheme URL is a peer that sent nonsense; an origin that parses perfectly
  // and simply is not this host's controller is a peer trying to make the host POST a transcript
  // and its durable credential somewhere else. The second is the only one of the two a reader
  // should be able to grep for, alert on, or count; folding it into the first would make an
  // exfiltration attempt indistinguishable from a typo in a URL.
  'bulk-target-invalid',
  'bulk-target-not-controller',
  'bulk-delivery-failed',

  // Paths.
  'path-not-absolute',
  'path-escapes-root',

  // The host's own gate: refusals this package decides by itself, with no controller involved.
  //
  // They are refusal reasons rather than deny messages, and that is the contract.
  // A deny decided by a controller is recorded `control/permission_denied`. If a locally-decided
  // refusal were also expressed as a deny it would carry that same cause, and the only thing telling
  // a local policy answer apart from a remote one would be free text in `detail` — which is
  // documented as never branched on. Naming them here makes the difference a fact code can read:
  // `state/model.ts`'s `CauseEvent` already admits every RefusalReason, so each of these becomes
  // `refusal/<name>` on the transition, distinct both from a controller's deny and from
  // `permission-decision-unavailable`, which means nobody decided at all.
  //
  //   path-input-missing        a path-taking tool whose input carries no readable path. A call
  //                             whose target cannot be found is not one that can be bounded.
  //   path-unresolvable         normalizing the path failed. Unresolvable is not provably inside.
  //   credential-path-denied    the call targets the host's own credential material. The agent runs
  //                             as the same OS user as the host, so file permissions are not a
  //                             boundary against it and this is the only control that is.
  //   shell-command-missing     a shell tool whose input carries no readable command.
  //   shell-boundary-command    a named boundary operation: publishing, remote surgery, branch
  //                             deletion, merging. Reported with the rule that fired.
  //   shell-verb-unrecognised   a git invocation whose verb is not provably safe. Not the same as
  //                             the above: this one fires on a verb nobody enumerated, the layer
  //                             that exists because a denylist under-includes (the plumbing behind
  //                             a publish can match none of its patterns).
  'path-input-missing',
  'path-unresolvable',
  'credential-path-denied',
  'shell-command-missing',
  'shell-boundary-command',
  'shell-verb-unrecognised',

  // Identity: acquiring, holding and presenting the user's own token.
  //
  // The split between `identity-not-configured` and `token-unavailable` is the one that matters.
  // The first says the operator has not set this host up; the second says they have, and nobody has
  // signed in yet (or the token aged out and there is no refresh token). They are different people's
  // problems on different days, and collapsing them would make the host's most common message
  // useless: "not configured" sent to someone who configured it a week ago reads as a bug.
  //
  //   identity-not-configured   no authority/client id is set. The host cannot even try.
  //   identity-config-invalid   set, but unusable: a non-https authority, a malformed redirect.
  //   token-unavailable         configured and valid, but there is no usable token right now.
  //
  // `auth-state-mismatch` is a security event, not a protocol hiccup, and it is named separately
  // for that reason. The loopback listener accepts a callback on 127.0.0.1, and the agent runs as
  // the same OS user as this host, the same fact that makes file permissions useless here. So any
  // local process can reach that listener, and an unverified callback would let one hand this host
  // an authorization code it obtained itself. The `state` value is what makes the callback provably
  // the answer to the request this host made. A mismatch is someone else talking.
  //
  //   auth-state-mismatch       the callback's `state` is not the one this host minted.
  //   auth-callback-refused     the callback carried no authorization code: the user declined, or
  //                             the provider returned an `error` instead.
  //   pkce-method-unsupported   a code-challenge method other than S256 was asked for. RFC 7636
  //                             permits `plain`; this host refuses it rather than merely not using
  //                             it, because an unused branch is one a later reader restores.
  //
  // The token endpoint's two failure kinds are split for the same reason the permission decision's
  // are: an outage and a shape this host does not recognise are different investigations.
  //
  //   token-request-failed      transport error, or a non-2xx this host may retry its way out of.
  //   token-response-invalid    2xx, and the body is not a token response this host can use.
  //   token-grant-rejected      The grant itself is dead, and no amount of retrying fixes it.
  //                             RFC 6749 calls this `invalid_grant`: the refresh token is expired,
  //                             revoked, or was issued to someone else. A person has to sign in.
  //                             It is split from `token-request-failed` because the two need
  //                             opposite actions. A provider that is briefly unreachable wants
  //                             patience; a grant that has lapsed wants a human, and a host that
  //                             waits politely for one to fix itself waits forever (a refresh token
  //                             that dies after a day of inactivity is a common provider policy).
  //                             Some providers append their own diagnostic code to
  //                             `error_description`; the code branches on the RFC name.
  //
  // The cache, and the mode check. Three outcomes rather than two, because on win32 a file written
  // 0600, one chmod'ed to 0600 and a deliberately world-readable 0666 all read back as 666.
  //
  //   credential-cache-unreadable   the cache exists and could not be read or parsed.
  //   credential-cache-write-failed the cache could not be written.
  //   credential-mode-too-wide      verify-after-write found the file readable by more than its
  //                                 owner on a platform that enforces modes. A real finding.
  //   credential-mode-unenforced    A named degrade, not a failure. This filesystem records only
  //                                 the write bit, so 0600 and 0666 are indistinguishable and
  //                                 privacy cannot be confirmed. The win32 shape. "Verified after
  //                                 write" is not available here, and saying so matters, because
  //                                 the alternative is a check that passes vacuously and reads as
  //                                 proof.
  //   credential-mode-unobservable  Inconclusive, and deliberately not the same reason. Nothing
  //                                 about a mode was observable at all, not even clearing the
  //                                 write bit, which win32 does record. So the probe cannot tell
  //                                 a filesystem that records nothing apart from a broken probe,
  //                                 and that is a thing to investigate rather than a fact about
  //                                 privacy. An instrument with no inconclusive state reports
  //                                 confidence it has not earned.
  //
  //   device-code-not-enabled   the device-code flow was reached without being configured. It is
  //                             never a silent fallback: the provider calls it a high-risk method
  //                             and recommends blocking it, so it must be asked for by name.
  //   device-code-declined      the device-code flow ended without a token: declined, expired, or
  //                             refused by the tenant.
  'identity-not-configured',
  'identity-config-invalid',
  'token-unavailable',
  'auth-state-mismatch',
  'auth-callback-refused',
  'pkce-method-unsupported',
  'token-request-failed',
  'token-response-invalid',
  'token-grant-rejected',
  'credential-cache-unreadable',
  'credential-cache-write-failed',
  'credential-mode-too-wide',
  'credential-mode-unenforced',
  'credential-mode-unobservable',
  'device-code-not-enabled',
  'device-code-declined',

  // The workspace a session runs in. Two reasons, split for the same reason as the session trio
  // above: provisioning failed means the session never got a directory and must not start;
  // releasing failed means the work is done and something was left behind. The first blocks, the
  // second is cleanup debt, and a host that reported both as one could never tell an operator
  // which of the two it was looking at.
  //
  //   workspace-provision-failed  no usable directory. Never a silent fallback to a temp path or to
  //                               the host's own cwd, which is how a session ends up writing into
  //                               the directory the host itself is running in.
  //   workspace-release-failed    the directory or worktree could not be released. Named rather than
  //                               swallowed: a release that quietly fails leaks a directory per
  //                               session, which is invisible until a disk fills.
  //   resume-cwd-not-honoured     a resume named a directory this host's provider would not honour
  //                               (anything but its own repository root). The CLI keeps transcripts
  //                               per cwd, so a resume moved into a provisioned workspace finds
  //                               nothing and becomes a fresh session that says nothing; refused by
  //                               name instead, on the wire.
  'workspace-provision-failed',
  'workspace-release-failed',
  'resume-cwd-not-honoured',

  // Tool descriptors the controller hands over, and the schemas they carry.
  //
  // `mcp-schema-unsupported` is the one that matters, and it exists to prevent a false green.
  // A converter that met a construct it did not recognise and fell back to a permissive schema would
  // register the tool successfully and validate nothing, so the property "a malformed call is
  // rejected" would be silently false for exactly the tools nobody checked, while every test stayed
  // green. Refusing at registration is loud, happens before any session exists, and names the
  // construct. A permissive fallback is the fail-open shape this package is built against.
  //
  //   mcp-descriptor-invalid   the descriptor itself is unusable: no name, no schema, a duplicate
  //                            name within one server.
  //   mcp-schema-unsupported   a schema construct this host cannot convert. Refused, never widened.
  //   mcp-tool-input-invalid   a call whose arguments failed the tool's own schema. The one of the
  //                            three that happens at run time rather than at registration.
  'mcp-descriptor-invalid',
  'mcp-schema-unsupported',
  'mcp-tool-input-invalid',

  // Durability: the transcript mirror, the transition log, and the receipt read.
  //
  // `receipt-anchor-unknown` is the one that matters, and it exists because the alternative is
  // invisible. A delivery receipt answers "did the text land?", and the only two honest answers are
  // yes and no. A third situation exists (the baseline anchor is not in the transcript at all, so
  // the question cannot be evaluated) and reporting that as "no" is the failure this whole read
  // path is built against: a controller that reads a false "no" pastes the text again. Naming it
  // makes "could not tell" a fact code branches on rather than a silence.
  //
  //   transcript-key-invalid       an empty project key or session id, or a subpath present and
  //                                empty. The store's key type calls an empty subpath invalid and
  //                                says to omit the field instead, so it is refused, not coerced;
  //                                coercing would silently address the main transcript when a
  //                                subagent's was asked for.
  //   transcript-entry-malformed   a stored line that will not round-trip. Round-tripping is the
  //                                only invariant the adapter contract requires, so a line failing
  //                                it is named rather than skipped: skipping is how a transcript
  //                                quietly loses entries nobody counted.
  //   transcript-read-failed       the store or the local file could not be read.
  //   transcript-write-failed      the append did not land anywhere.
  //   receipt-anchor-unknown       see above. Not a negative receipt.
  //   retention-window-invalid     a retention window that is negative or not a number. Refused
  //                                rather than defaulted, because a default here silently deletes
  //                                on a schedule nobody chose.
  //   gate-cannot-grant            A degrade, not a blocked call, and the only entry here that
  //                                reports on the gate's own configuration rather than on a request.
  //                                Raised once per gate, on the first allow issued while
  //                                `grantOnAllow` is off: the call was approved and the tool still
  //                                will not run, because a silent allow leaves the agent's own
  //                                permission mode to decide and a host has nobody to answer it.
  //                                Named because the alternative is nothing at all, on every
  //                                approved call, for the life of the session.
  'transcript-key-invalid',
  'transcript-entry-malformed',
  'transcript-read-failed',
  'transcript-write-failed',
  'receipt-anchor-unknown',
  'retention-window-invalid',
  'gate-cannot-grant',

  // The discovery door: reading the agent CLI's own transcript directory, jailed.
  //
  //   transcript-path-escape    A name that could shape a path outside the projects root. One
  //                             reason for all three layers of the jail (the name allowlist, the
  //                             explicit dot-name reject, and the resolve-then-containment check)
  //                             with `detail` naming which layer refused. It is not
  //                             `path-escapes-root`: that names the workspace jail around a
  //                             session's own files; this names the read-only door over a directory
  //                             the host reads on the controller's behalf. An absent transcript is
  //                             not this: absence is a value the door reports, never a refusal.
  'transcript-path-escape',

  // The configure ask: a controller changing this host's own config file over the wire.
  //
  //   config-key-unknown        An entry names a key this host does not take over the wire: a key
  //                             outside the closed config set, or one of the keys that name the
  //                             controller itself (the URLs, the host id). A controller re-pointing
  //                             a host at another controller has no legitimate use, so those keys
  //                             are refused here by name; the detail lists the settable set.
  //   config-value-invalid      A value the host would refuse at start-up: a root that is not
  //                             absolute, a branch scheme with no `{key}`, an unknown placeholder,
  //                             an unmatched brace, a literal that renders an illegal branch, a
  //                             scheme with no repository root behind it. Screened as a whole set
  //                             before any write, so a half-applied posture never lands.
  //   config-host-busy          The ask changes a workspace root while a session is live or
  //                             opening. A session releases through the provider that provisioned
  //                             it; swapping roots under one turns that release into a guess. Close
  //                             the sessions and ask again.
  //   config-write-failed       The file could not be written: the directory is unwritable, the
  //                             existing file is corrupt (fix or remove it first), or this host was
  //                             composed without a configuration seam at all.
  'config-key-unknown',
  'config-value-invalid',
  'config-host-busy',
  'config-write-failed',

  // The inventory: listing the worktrees under the workspace root from disk.
  //
  //   workspace-list-failed     The host could not look: no workspace provider, a provider that
  //                             keeps no inventory, or git refusing to list. The detail names which.
  'workspace-list-failed',

  // The repository read: a controller listing a directory or reading a text file of the operator's
  // checkout through this host, jailed to the repository root.
  //
  //   repository-path-escape    The asked path resolves outside the repository root, or this host
  //                             has no repository root to read under. The same shape as
  //                             `transcript-path-escape`, over a different root; an absent file or
  //                             directory is not this, it is `repository-read-failed`.
  //   repository-read-failed    The path is not a directory (for a listing) or not a file (for a
  //                             read), the file holds a NUL byte in its head (binary; the answer is
  //                             a string), or the filesystem refused. The detail names which.
  'repository-path-escape',
  'repository-read-failed',

  // The branch half of a release: deleting a branch is not reversible, so it is refused by name
  // rather than done quietly.
  //
  //   branch-not-merged         The ask said deleteBranch without force and the branch is not in
  //                             the default branch (or no default branch exists to judge by). Nothing
  //                             was removed: the check runs before the directory goes.
  'branch-not-merged',
] as const;

export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/** A named refusal. `detail` is for a human reading a log; `reason` is what code branches on. */
export interface Refusal {
  readonly reason: RefusalReason;
  readonly detail: string;
}

export function refusal(reason: RefusalReason, detail: string): Refusal {
  return { reason, detail };
}

/**
 * The reasons a retry cannot help with: the credential is gone until a person restores it.
 *
 * This is a predicate and not a comment because the link's reconnect loop is correct for every
 * transient failure and actively harmful for these: it dials a door that structurally cannot open,
 * forever, while the one fact the operator could act on scrolls past as another retry. So "is this
 * terminal" has to be a thing code branches on, and it has to have one home; a second list
 * somewhere else is how the link and the reporter end up disagreeing about whether a host is dead.
 *
 * The set is deliberately small, and erring toward transient is the safe direction. Treating a
 * recoverable failure as terminal takes down a host that would have healed; treating a terminal one
 * as recoverable costs a retry loop that is loud. Only reasons whose own detail already ends in
 * "sign in again" belong here.
 *
 * `link-unauthorized` is the third member, and it is the only one the token layer cannot raise.
 * The provider judged the material and approved it; the controller refused it at the upgrade. The
 * conclusion is identical (the next dial with the same identity refuses identically, and only a
 * person can change what is presented), so it takes the same exit rather than a second, private
 * notion of "terminal" living in the link.
 *
 * `credential-unavailable` is not one of them, and must never be. It is what a host with no
 * identity configured reports on every dial, and that host is supposed to keep connecting without a
 * header, the supported no-identity mode. Putting it here would turn the most common unconfigured
 * setup into a host that refuses to start.
 */
export function needsHumanReauthentication(reason: RefusalReason): boolean {
  return (
    reason === 'token-grant-rejected' || reason === 'token-unavailable' || reason === 'link-unauthorized'
  );
}

export function isRefusalReason(value: string): value is RefusalReason {
  return (REFUSAL_REASONS as readonly string[]).includes(value);
}
