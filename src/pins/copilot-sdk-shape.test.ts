/**
 * The Copilot seam's structural types, held to the SDK's own declared types at the pinned version.
 *
 * `src/host/copilot-sdk.ts` names no type of `@github/copilot-sdk`, so no declaration this package ships
 * names a package a consumer may not have. What keeps its interfaces honest is this file: each entry below
 * compiles only while the SDK's declared types agree with the seam, in the direction the seam uses them.
 * What this host hands the SDK must be what the SDK takes; what the SDK hands back must be what this host
 * reads. A release that renames a member, narrows a parameter or drops an export fails the build here, by
 * line, before any session runs on it.
 *
 * The import is type-only and this file is a test: nothing here ships or loads the SDK at run time. It
 * reads the exact development dependency, which the confinement pin holds to the pinned version.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type * as Sdk from '@github/copilot-sdk';

import type {
  CopilotClient,
  CopilotClientOptions,
  CopilotConnection,
  CopilotEvent,
  CopilotMcpServer,
  CopilotPermissionAnswer,
  CopilotPermissionRequest,
  CopilotPreToolInput,
  CopilotPreToolOutput,
  CopilotProvider,
  CopilotSdk,
  CopilotSession,
  CopilotSessionConfig,
  CopilotTokenAnswer,
  CopilotTokenRequest,
} from '../host/copilot-sdk.js';

/** True when `A` can be used where `B` is expected. */
type Assignable<A, B> = [A] extends [B] ? true : false;

/** Each entry compiles only while it is `true`: `true satisfies false` is a type error naming the line. */
const SHAPE = {
  // What this host hands the SDK.
  sessionConfig: true satisfies Assignable<CopilotSessionConfig, Sdk.SessionConfig>,
  resumeConfig: true satisfies Assignable<CopilotSessionConfig, Sdk.ResumeSessionConfig>,
  clientOptions: true satisfies Assignable<CopilotClientOptions, Sdk.CopilotClientOptions>,
  connection: true satisfies Assignable<CopilotConnection, Sdk.RuntimeConnection>,
  mcpServer: true satisfies Assignable<CopilotMcpServer, Sdk.MCPServerConfig>,
  provider: true satisfies Assignable<CopilotProvider, Sdk.ProviderConfig>,
  preToolOutput: true satisfies Assignable<
    CopilotPreToolOutput,
    NonNullable<Awaited<ReturnType<NonNullable<NonNullable<Sdk.SessionConfig['hooks']>['onPreToolUse']>>>>
  >,
  permissionAnswer: true satisfies Assignable<
    CopilotPermissionAnswer,
    Awaited<ReturnType<Sdk.PermissionHandler>>
  >,
  tokenAnswer: true satisfies Assignable<CopilotTokenAnswer, Awaited<ReturnType<Sdk.GitHubTokenProvider>>>,
  // What the SDK hands back.
  sdk: true satisfies Assignable<
    { CopilotClient: typeof Sdk.CopilotClient; RuntimeConnection: typeof Sdk.RuntimeConnection },
    CopilotSdk
  >,
  client: true satisfies Assignable<Sdk.CopilotClient, CopilotClient>,
  session: true satisfies Assignable<Sdk.CopilotSession, CopilotSession>,
  event: true satisfies Assignable<Sdk.SessionEvent, CopilotEvent>,
  permissionRequest: true satisfies Assignable<Sdk.PermissionRequest, CopilotPermissionRequest>,
  preToolInput: true satisfies Assignable<
    Parameters<NonNullable<NonNullable<Sdk.SessionConfig['hooks']>['onPreToolUse']>>[0],
    CopilotPreToolInput
  >,
  tokenRequest: true satisfies Assignable<Parameters<Sdk.GitHubTokenProvider>[0], CopilotTokenRequest>,
} as const;

test('the seam agrees with the SDK at the pinned version, in the direction each type is used', () => {
  // The proof is the compile; this states that every entry above was compiled.
  assert.equal(Object.keys(SHAPE).length, 16);
  assert.ok(Object.values(SHAPE).every((holds) => holds));
});
