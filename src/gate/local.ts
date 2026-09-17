/**
 * The host's own gate — a refusal that does not depend on the controller behaving.
 *
 * This is what makes the package installable by a stranger. A host that executes whatever a
 * remote server sends is, mechanically, a code-execution service on somebody else's machine. An
 * optional callback defaulting to escalate-everything is the opposite of an answer to that. This
 * module refuses locally, offline, by rules that ship with the package — so the property can be
 * demonstrated by somebody who does not trust the controller at all, which is the only audience the
 * claim matters to.
 *
 * The vocabulary is owned locally, not received. A policy the controller can change remotely is a
 * policy that depends on the controller behaving, which defeats the module. At the exact moment this
 * is load-bearing — the controller unreachable — a cached remote policy is the only thing acting, so
 * receiving-and-caching is local ownership plus a remote mutation path, for no benefit when it
 * counts.
 *
 * Owned is not hardcoded, and that is what makes it survivable. The embedder chooses the tool
 * families and the protected-path list at construction, in-process, before any session exists. The
 * wire carries no policy in either direction.
 *
 * It adds refusals and never removes one. A tool this module has no opinion about returns null and
 * the surrounding gate goes on to ask whoever it was going to ask. Two mechanisms, one invariant —
 * the same posture the outer gate takes toward the operator's own settings.
 */
import type { Refusal } from '../core/refusal.js';
import { refusal } from '../core/refusal.js';
import type { DecisionRequest } from './decision.js';
import type { JailOptions, PathResolver } from './jail.js';
import { checkPath, checkShellForProtectedPaths, commandFromToolInput, pathFromToolInput } from './jail.js';
import { classifyShellCommand } from './shell.js';
import { parseCommand } from './command.js';

/**
 * Decides one tool call, locally. Null means no local opinion, never "allowed".
 *
 * Synchronous and total by contract: this runs before anything is asked of anyone, and an
 * asynchronous local policy would be a second place a decision can hang.
 */
export type LocalGate = (request: DecisionRequest) => Refusal | null;

/** The tool families this module recognises. Data, so an embedder can state its own. */
export interface ToolFamilies {
  /** Tools whose input names a path they will write. */
  readonly write: readonly string[];
  /** Tools whose input names a path they will read. Present because of the credential denial. */
  readonly read: readonly string[];
  /** Tools that run a command. */
  readonly shell: readonly string[];
}

/**
 * The SDK's own tool names.
 *
 * Read tools are jailed too. Reading source is benign; reading the host's token cache is not, and
 * the two arrive through the same tool. The jail
 * bounds where reads may go and the protected set names what is off-limits wherever it sits.
 */
export const DEFAULT_TOOL_FAMILIES: ToolFamilies = {
  write: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
  read: ['Read', 'NotebookRead'],
  shell: ['Bash', 'PowerShell'],
};

export interface LocalGateOptions {
  /** The absolute root every path-taking call must resolve inside. */
  readonly workspaceRoot: string | null;
  /** The real resolver. `host/paths.ts` holds the one built on `node:path`. */
  readonly resolve: PathResolver;
  /** Absolute paths holding credential material. `host/paths.ts` computes the default set. */
  readonly protectedPaths: readonly string[];
  /** Defaults to `DEFAULT_TOOL_FAMILIES`. */
  readonly toolFamilies?: ToolFamilies;
}

/**
 * Build the local gate.
 *
 * The returned function is pure, synchronous and total — so it composes into whatever assembles a
 * session later, and needs no composition root to exist first.
 */
export function localGate(options: LocalGateOptions): LocalGate {
  const families = options.toolFamilies ?? DEFAULT_TOOL_FAMILIES;
  const jail: JailOptions = {
    workspaceRoot: options.workspaceRoot,
    resolve: options.resolve,
    protectedPaths: options.protectedPaths,
  };

  const writeTools = new Set(families.write);
  const readTools = new Set(families.read);
  const shellTools = new Set(families.shell);

  return (request: DecisionRequest): Refusal | null => {
    if (shellTools.has(request.toolName)) {
      const command = commandFromToolInput(request.toolInput);
      if (command === null) {
        return refusal(
          'shell-command-missing',
          'this tool runs a command and the input carries none, so there is nothing to classify — refused rather than guessed',
        );
      }
      // One parse, both consumers. The credential check runs first because a command naming the
      // token cache is the more serious of the two answers and should be the one the reader gets.
      const parsed = parseCommand(command);
      return checkShellForProtectedPaths(command, jail) ?? classifyShellCommand(command, parsed);
    }

    if (writeTools.has(request.toolName) || readTools.has(request.toolName)) {
      return checkPath(pathFromToolInput(request.toolInput), jail);
    }

    // No opinion. The surrounding gate asks whoever it was going to ask.
    return null;
  };
}
