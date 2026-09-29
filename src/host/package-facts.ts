/**
 * Version facts read from manifests: this package's own, and the installed agent SDK's.
 *
 * Read here rather than baked in at build: a manifest is the one place a version is stated, and a
 * constant copied into source would be a second place that can drift. The reads are lazy and
 * memoised, and a manifest that cannot be read reports `unknown` or null rather than failing a verb
 * that only wanted to print a line.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

/** The running package's version, or `unknown` when the manifest cannot be read. */
export function packageVersion(): string {
  if (cached !== null) return cached;
  try {
    const manifestPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown };
    cached = typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached;
}

const AGENT_SDK = '@anthropic-ai/claude-agent-sdk';

/** The installed agent SDK's version, and the version of Claude Code it bundles. */
export interface AgentSdkFacts {
  readonly sdkVersion: string;
  readonly claudeCodeVersion: string;
}

let sdkFacts: AgentSdkFacts | null | undefined;

/**
 * The installed agent SDK's version and the Claude Code version it bundles, from the SDK's own
 * manifest, or null when that cannot be read.
 *
 * The SDK's `exports` map does not expose `./package.json`, so the manifest cannot be imported by
 * name: the package entry is resolved the way an import would resolve it, and the manifest is the
 * nearest one above that file that names the SDK.
 */
export function agentSdkFacts(): AgentSdkFacts | null {
  if (sdkFacts !== undefined) return sdkFacts;
  sdkFacts = null;
  try {
    let directory = dirname(fileURLToPath(import.meta.resolve(AGENT_SDK)));
    for (let depth = 0; depth < 4; depth += 1) {
      const manifest = readManifest(join(directory, 'package.json'));
      if (manifest !== null && manifest.name === AGENT_SDK) {
        const { version, claudeCodeVersion } = manifest;
        if (typeof version === 'string' && version !== '' && typeof claudeCodeVersion === 'string') {
          sdkFacts = claudeCodeVersion === '' ? null : { sdkVersion: version, claudeCodeVersion };
        }
        break;
      }
      directory = dirname(directory);
    }
  } catch {
    sdkFacts = null;
  }
  return sdkFacts;
}

function readManifest(
  path: string,
): { name?: unknown; version?: unknown; claudeCodeVersion?: unknown } | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as {
      name?: unknown;
      version?: unknown;
      claudeCodeVersion?: unknown;
    };
  } catch {
    return null;
  }
}
