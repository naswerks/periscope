/**
 * Facts about the machine this host runs on.
 *
 * Inside `src/host/` because it reaches `node:os`. Everything outward takes these as plain values,
 * which is what lets the rest of the package run in a test, a browser, or a controller unchanged.
 */
import { homedir, hostname, platform, release, tmpdir } from 'node:os';

export interface MachineFacts {
  readonly hostname: string;
  readonly platform: NodeJS.Platform;
  readonly release: string;
  readonly homeDir: string;
  readonly tempDir: string;
}

export function readMachineFacts(): MachineFacts {
  return {
    hostname: hostname(),
    platform: platform(),
    release: release(),
    // On Windows this resolves the USERPROFILE family, not HOME. Code keyed on HOME alone finds
    // nothing there and fails without saying so.
    homeDir: homedir(),
    tempDir: tmpdir(),
  };
}
