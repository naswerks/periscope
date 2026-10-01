/**
 * The two impure inputs the host's own gate needs: a real path resolver, and the set of absolute
 * paths that hold credential material.
 *
 * Why it lives here: `core/paths.ts` resolves textually and never consults the filesystem, by
 * contract, because the core must run anywhere — and its own header says a caller enforcing a real
 * jail supplies a real resolver. Reading a home directory is reading the machine, and `src/host/` is
 * where the boundary pin says that belongs. The gate takes both of these as INJECTED values, so the
 * policy stays testable with a resolver that throws and a protected set nobody has to have on disk.
 */
import { homedir } from 'node:os';
import { isAbsolute, resolve as resolvePath } from 'node:path';

/**
 * The real resolver.
 *
 * It is cwd-relative for a relative input, and that is exactly why the gate checks
 * `isAbsolutePath` on the RESULT rather than trusting it. `node:path`'s `resolve` will happily turn
 * `../../etc/passwd` into an absolute path against wherever this process happens to be — which is a
 * different directory from the session's workspace. The jail's containment check is what catches
 * that, and it catches it because the resolution happened first.
 *
 * It also handles what the textual resolver cannot: Windows drive-relative paths (`C:foo` means
 * "foo relative to the current directory ON DRIVE C", not `C:\foo`), UNC roots, and mixed separators.
 * Those are the shapes a hand-rolled normalizer gets subtly wrong, and each one is a way out of a
 * jail built on string comparison.
 */
export function nodePathResolver(candidate: string): string {
  const resolved = resolvePath(candidate);
  // `resolve` is total, but a caller reading this wants to know the post-condition is checked rather
  // than assumed — an unrooted result would make every containment answer meaningless.
  if (!isAbsolute(resolved))
    throw new Error(`resolving ${candidate} produced a non-absolute path: ${resolved}`);
  return resolved;
}

/**
 * Where this host keeps its own credential material.
 *
 * This function is the single source, and that is the whole design. Both the path the host
 * writes its token cache to and the set of paths the gate refuses derive from this one call, so
 * they cannot disagree. The alternative (computing the cache path in one module and listing a
 * protected path in another) is two facts that must be kept equal by hand, and nothing goes red
 * when they drift apart: the cache tests still pass, the gate tests still pass, and the credential
 * is simply unprotected.
 *
 * Why not just put the cache under `~/.claude`, which is already protected? Because that is the
 * agent CLI's directory, and inheriting protection by squatting in somebody else's namespace is
 * coincidence, not design. It would break the moment either side reorganised, and the breakage
 * would be silent in exactly the same way.
 *
 * `PERISCOPE_CONFIG_DIR` overrides it, so an operator who keeps credentials on a separate volume
 * gets the protection at the new location automatically rather than having to know to say so twice.
 */
export function periscopeCredentialDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env['PERISCOPE_CONFIG_DIR'];
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();

  const home = env['USERPROFILE'] ?? env['HOME'] ?? safeHomedir();
  if (home === null || home === '') return null;
  return join(home, '.periscope');
}

/**
 * The file the host's token cache lives in.
 *
 * Null when there is nowhere to put it — no home directory and no configured location. A caller
 * that gets null has no cache, which is a refusable state and never a reason to fall back to a
 * world-readable temp file.
 */
export function tokenCachePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = periscopeCredentialDir(env);
  return dir === null ? null : join(dir, 'token-cache.json');
}

/**
 * The file this machine's paired credential lives in — beside the token cache, deliberately: the
 * gate's protected set names the DIRECTORY, so living here is what protects it. Null when there is
 * nowhere to put it, same contract as the cache.
 */
export function pairedCredentialPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = periscopeCredentialDir(env);
  return dir === null ? null : join(dir, 'paired-credential.json');
}

/** The home directory the host and the agent share: the environment's spelling, else the OS's. */
export function homeDirectory(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env['USERPROFILE'] ?? env['HOME'] ?? safeHomedir();
  return home === null || home === '' ? null : home;
}

/**
 * Where credential material lives, as absolute paths.
 *
 * This exists because file permissions are not a boundary here. The agent runs as the same OS
 * user as the host, so a 0600 token file is readable by the agent exactly as it is by the host. No
 * mode, no owner and no ACL separates them. The gate refusing these paths is the only local
 * control there is: the read, write and search tools, and shell commands naming a path literally or
 * through a home-directory form (`~`, `$HOME`, `%USERPROFILE%`). A symlink to one of these paths is
 * outside that scope. Without this list "the agent holds no credential" is true only in the narrowest
 * sense: it holds none of its own, and can read the host's.
 *
 * The set names credential material, not the directories it sits in. An agent reads its own CLI's
 * settings, skills and tool output under the CLI's home; what it may not read is the CLI's token cache
 * (`.credentials.json`) and the configuration file that can carry an API key (`.claude.json`).
 *
 * The set is returned, not applied. The embedder receives it, may add to it, and hands it to the
 * gate at construction. A policy the caller cannot read back is a policy the caller cannot audit.
 *
 * Ambient cloud credentials are included deliberately. They are not this package's credentials,
 * but they are reachable by the same user through the same tools, and a host that guards only its
 * own secrets while the agent reads the machine's has guarded the cheaper half.
 *
 * `env` is passed in rather than read from the process so this is testable and so an embedder
 * composing several sessions can state a different environment for each.
 */
export function credentialPaths(
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly agentHome?: string | null } = {},
): string[] {
  const home = homeDirectory(env);
  const paths: string[] = [];
  const add = (path: string): void => {
    if (!paths.includes(path)) paths.push(path);
  };
  // The two files of an agent CLI home that hold or can hold a credential.
  const cliHome = (directory: string): void => {
    add(join(directory, '.credentials.json'));
    add(join(directory, '.claude.json'));
  };

  // The host's own credential directory, first, and derived rather than spelled out. The
  // directory is named rather than the file, so anything the host later keeps beside the token
  // cache is protected by having been put there, not by somebody remembering to add a line.
  //
  // Removing these two lines takes tests red across three lanes at once (read, write and shell)
  // because all three read this one list. That is the point of deriving it here rather than
  // restating the path where the cache is written.
  const own = periscopeCredentialDir(env);
  if (own !== null) add(own);

  if (home !== null) {
    // The agent CLI's token cache, in its default home, and its configuration file beside that home.
    // A protected path covers everything beneath it; a file simply has nothing beneath it.
    cliHome(join(home, '.claude'));
    add(join(home, '.claude.json'));
    // Ambient cloud credentials reachable by the same user.
    add(join(home, '.aws'));
    add(join(home, '.config', 'gcloud'));
    add(join(home, '.azure'));
    // SSH keys: not a token cache, but the same class — material that authenticates this user.
    add(join(home, '.ssh'));
  }

  // An explicitly configured CLI home keeps its credential files there instead.
  const configured = env['CLAUDE_CONFIG_DIR'];
  if (typeof configured === 'string' && configured.trim() !== '') cliHome(configured);

  // The effective agent home, when it is not the default under the home directory: the agent CLI keeps
  // its token cache there, so protecting only `~/.claude`'s would leave a host configured with
  // `PERISCOPE_AGENT_HOME` guarding the wrong file. The composition root passes the value it resolved
  // (environment or config file); the environment key alone is read here for a caller that has
  // nothing else.
  const agentHome = options.agentHome ?? env['PERISCOPE_AGENT_HOME'] ?? null;
  if (typeof agentHome === 'string' && agentHome.trim() !== '') cliHome(agentHome);

  return paths;
}

/**
 * `join` without importing it: these are all one-level appends and the resolver normalizes after.
 * The separator follows the base, so a Windows home spelled `C:\Users\x` prints as one
 * (`C:\Users\x\.periscope`) rather than as a mix the operator has to read twice.
 */
export function join(base: string, ...segments: string[]): string {
  const trimmed = base.replace(/[\\/]+$/, '');
  const separator = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/';
  return [trimmed, ...segments].join(separator);
}

/** `homedir()` throws on a system with no resolvable home; a missing home is not a reason to fail. */
function safeHomedir(): string | null {
  try {
    const home = homedir();
    return home === '' ? null : home;
  } catch {
    return null;
  }
}
