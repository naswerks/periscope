# Identity

How a host proves who it is to a controller, and what protects the material it holds. The wire
side of this (the credential on the three transports, pairing as a contract) is in
[protocol.md](protocol.md); what the gate keeps the agent away from is in [gate.md](gate.md).

A host presents one credential on every transport it uses, and there are three postures:

| Posture       | What is presented                                                   | Choose it when                                                                                     |
| ------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **paired**    | a machine credential the controller minted (`p1.<hostId>.<secret>`) | the host runs unattended; the credential has no clock and dies only when the controller revokes it |
| **signed-in** | a real user's own access token, refreshed by the host               | a person is at the machine and the controller wants a user identity, not a machine one             |
| **none**      | nothing; the host connects without a header and says so at start-up | the controller is reachable only from inside a network that is itself the boundary                 |

The daemon never signs anyone in. `periscope login` writes the token cache; `periscope pair <code>`
writes the paired credential; `serve` presents what is already there and refuses by name when it is
not. When both exist the paired credential wins: a refresh token can lapse after a period of
inactivity, and a paired credential cannot.

## The agent's own identity is separate

The credential above authenticates the host to the controller. The agent the host spawns
authenticates to its own provider separately, through the Claude Code CLI's ambient credential
under the agent home (`~/.claude` by default). The spawn environment is an allow-list, so
`ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` set on the host are not inherited by a session;
sign the CLI in once, as the OS user that runs the host (`claude auth login`; `claude auth status`
confirms), or pass a key to one session through `session_new.request.env.extraEnv`.

## Pairing: the durable machine credential

A signed-in user mints a short-lived single-use code from the controller, and
`periscope pair <code> --controller <origin> --label <name>` trades it for this machine's own
credential, written beside the token cache under the config directory, presented on every dial,
preferred over the token cache when both exist.

|                                  |                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What it is**                   | A controller-minted bearer shaped `p1.<hostId>.<secret>`, scoped to the user who minted the code. The shape is the contract: the host reads its own id out of it, and `pair` refuses an answer outside the shape before writing anything. A controller keeps only a hash of the secret; this machine holds the one copy                                                                                    |
| **Where the redemption door is** | `--controller <origin>` when given (its origin plus the controller's pair route, `/api/periscope/pair`); else `PERISCOPE_PAIR_URL` when set; else the origin of `PERISCOPE_DECISION_URL` plus that route. A 404 at the door is named as a wrong door, not as a refused code                                                                                                                                |
| **What else the answer carries** | The controller names the link and decision URLs this host should dial (`controllerUrl`, `decisionUrl`). When both arrive, `pair` writes `PERISCOPE_CONTROLLER_URL` and `PERISCOPE_DECISION_URL` to the config file beside the credential, so `serve` needs nothing else; the environment still wins per key, and the write says so when it is shadowed. A controller that names neither leaves both to you |
| **Revocation**                   | The controller's, per machine: it refuses the bearer at the upgrade (401 or 403) and closes the link. The host reads that as `link-unauthorized`, which is terminal: it exits non-zero naming the remedy, a fresh `periscope pair <code>`                                                                                                                                                                  |
| **The label**                    | `--label <name>` names this machine in the controller's listings; `PERISCOPE_MACHINE_LABEL` when the flag is absent; the hostname otherwise                                                                                                                                                                                                                                                                |

## Signing in as a user

The host signs in as a real user and presents that user's own access token. No provider hostname or
tenant is baked in: the authority, client id, scopes and endpoints are configuration, and a test
fails the build if a provider hostname appears in shipped code. One provider-specific error code is
recognised (`AUTH_FLOW_BLOCKED_CODES` in `src/identity/device-code.ts`), so that material a
provider's policy has blocked is discarded and named rather than refreshed forever.

|                                 |                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Primary flow**                | Loopback authorization code + PKCE (`S256` only; `plain` is refused, not merely unused), the same shape `az`, `gh` and `kubectl` use. The listener binds `127.0.0.1` explicitly, accepts exactly one callback, and times out                                                                          |
| **`state` is verified, always** | PKCE protects the code exchange; `state` protects the callback. They are not substitutes. The agent shares this host's OS user, so any local process can reach the loopback listener, and an unverified callback would let one hand this host a code it obtained itself                               |
| **Fallback**                    | Device code, off unless `PERISCOPE_IDENTITY_DEVICE_CODE=1`. Never reached by falling back. Some providers class it as a high-risk flow and let organisations block it by policy, and a device-code sign-in can poison the cache for any other flow, so switching flows discards rather than refreshes |
| **Cache**                       | One JSON file, written `0600`, verified after write. See the limit below                                                                                                                                                                                                                              |
| **Configuration**               | `PERISCOPE_IDENTITY_AUTHORITY` + `PERISCOPE_IDENTITY_CLIENT_ID` are required together. Set neither and the host starts without identity. Set one wrongly and the host refuses to start: a typo must not degrade into "authenticating as nobody"                                                       |

## What `0600` is, and what it is not

It is not a boundary against the agent. The agent runs as the same OS user as this host, so an
`0600` token file is readable by it exactly as it is by the host. What keeps the agent out is the
gate's credential-path denial, and that denial covers this file because `credentialPaths()` and
`tokenCachePath()` are derived from one function, not kept equal by hand.

The improvement is still real, and it is a change of order rather than degree: what this replaces
is a shared secret granting access as _every_ user. What it stores is _one user's own_ token,
expiring by itself and revocable from the provider without touching this machine.

On Windows the mode cannot be confirmed at all. Measured: a file written `0o600`, a file `chmod`ed
to `0o600`, and a deliberately world-readable one all report `0o666`. So the host probes what the
filesystem actually records and reports `credential-mode-unenforced` as a named degrade where
privacy is unconfirmable. It does not claim a privacy it cannot verify.

The probe proves it is alive before it reports a negative. `chmod 0444` _does_ read back as `444`
on Windows (the write bit is the one real bit there), so the probe takes that reading as a positive
control. Three outcomes, never two:

|                  |                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enforced`       | POSIX modes are honoured; the file is verified, and one wider than requested is refused                                                           |
| `write-bit-only` | Only writability is recorded, so privacy is unconfirmable. A finding                                                                              |
| `unobservable`   | Not even clearing the write bit changed anything: inconclusive, and reported as a different reason. A probe that cannot fail is not a measurement |

`0444` is the control, never the target: the cache stays owner-writable because refreshes are
written to it.

## Deployment: where the app registration lives

One public-client registration with a loopback redirect, at any OIDC provider that supports the
authorization-code flow with PKCE. The host consumes it; it never creates it.

A tenant or organisation gets its own registration, and the host is pointed at it through
`PERISCOPE_IDENTITY_AUTHORITY`. That is a deployment step, not a code path, which is the reason the
authority is configuration. Some provider tenant types are single-tenant by construction, in which
case one registration cannot be shared across tenants and each deployment registers its own.

## Where things live

| Path                                  | What                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/identity/`                       | The generic OIDC client: config, PKCE, the authorization and device-code flows, the token store |
| `src/identity/paired-credential.ts`   | The paired credential's shape and the reader that refuses a file whose two copies disagree      |
| `src/host/sign-in.ts`                 | The interactive flows the `login` verb runs; the refresher the daemon presents                  |
| `src/host/paths.ts`                   | Where the cache, the paired credential and the config file live, and the protected set          |
| `src/bin/login.ts`, `src/bin/pair.ts` | The two verbs                                                                                   |
