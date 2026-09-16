/**
 * The whole sign-in, end to end, against a real local provider.
 *
 * This is the test that says identity works rather than that its parts do. Every other identity
 * test drives one module. These start a real HTTP server that speaks the provider's half — discovery
 * document, authorization redirect, token endpoint — run the actual `signIn`, and read the token out
 * of a real file afterwards. The loopback listener really binds, the browser step really redirects,
 * the code is really redeemed.
 *
 * What it is still not: a real identity provider. There is no app registration behind this, and
 * there deliberately cannot be; creating one is a human act. So conditional access, tenant policy,
 * consent, and the provider's real error vocabulary are not exercised. What is exercised is every
 * line of this package's own flow.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileTokenCache } from './token-cache.js';
import type { DeviceCodeInstruction } from './sign-in.js';
import { refresherFor, resolveEndpoints, signIn, signInWithDeviceCode } from './sign-in.js';
import type { IdentityConfig } from '../identity/config.js';
import { TokenCredential } from '../identity/credential.js';

const NOW = 1_800_000_000_000;

/** A provider that speaks just enough of the protocol to be redeemed against. */
function provider(
  options: {
    tokenStatus?: number;
    tokenBody?: unknown;
    onAuthorize?: (params: URLSearchParams) => void;
  } = {},
) {
  const seen: { authorize: URLSearchParams | null; tokenBody: string | null } = {
    authorize: null,
    tokenBody: null,
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/.well-known/openid-configuration') {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` }),
      );
      return;
    }

    if (url.pathname === '/authorize') {
      seen.authorize = url.searchParams;
      options.onAuthorize?.(url.searchParams);
      // Play the browser: redirect straight back to the host's loopback listener.
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
      redirect.searchParams.set('code', 'the-authorization-code');
      redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
      response.writeHead(302, { location: redirect.toString() });
      response.end();
      return;
    }

    if (url.pathname === '/token') {
      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', () => {
        seen.tokenBody = body;
        response.writeHead(options.tokenStatus ?? 200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify(
            options.tokenBody ?? {
              access_token: 'the-access-token',
              refresh_token: 'the-refresh-token',
              expires_in: 3600,
              token_type: 'Bearer',
            },
          ),
        );
      });
      return;
    }

    response.writeHead(404);
    response.end();
  });

  return new Promise<{ port: number; seen: typeof seen; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        seen,
        close: () => {
          server.close();
          server.closeAllConnections?.();
        },
      });
    });
  });
}

function configFor(port: number, overrides: Partial<IdentityConfig> = {}): IdentityConfig {
  return {
    // The https rule is enforced in `readIdentityConfig`, not in this type. A test provider on
    // loopback http is exactly the case that rule exists to keep OUT of a real deployment, so it is
    // constructed here directly rather than by making the rule leaky.
    authority: `http://127.0.0.1:${port}`,
    clientId: 'client-abc',
    scopes: ['openid', 'offline_access'],
    endpoints: null,
    redirectPort: 0,
    deviceCodeEnabled: false,
    ...overrides,
  };
}

/** The browser: follow the authorization URL, which redirects to the host's listener. */
const followRedirect = (url: string): void => {
  void fetch(url, { redirect: 'follow' }).catch(() => undefined);
};

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'periscope-signin-'));
}

test('regression: a whole sign-in: discovery, authorize, redeem, and the token lands in the cache file', async () => {
  const idp = await provider();
  const dir = scratch();
  try {
    const cache = new FileTokenCache(join(dir, 'token-cache.json'));

    const result = await signIn(configFor(idp.port), cache, {
      present: followRedirect,
      nowMs: () => NOW,
      timeoutMs: 10_000,
    });

    assert.ok(result.ok, result.ok === false ? result.refusal.detail : '');
    assert.equal(result.value.tokens.accessToken, 'the-access-token');
    assert.equal(result.value.protocol, 'loopback');

    // Read the real file, not the return value — persistence is the thing being claimed.
    const onDisk = JSON.parse(readFileSync(join(dir, 'token-cache.json'), 'utf8')) as {
      tokens: { accessToken: string };
    };
    assert.equal(onDisk.tokens.accessToken, 'the-access-token');
  } finally {
    idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: the authorization request carried PKCE and a state, and the exchange carried the verifier', async () => {
  const idp = await provider();
  const dir = scratch();
  try {
    await signIn(configFor(idp.port), new FileTokenCache(join(dir, 'token-cache.json')), {
      present: followRedirect,
      timeoutMs: 10_000,
    });

    assert.equal(idp.seen.authorize?.get('code_challenge_method'), 'S256');
    assert.ok((idp.seen.authorize?.get('state') ?? '').length > 20);

    const exchange = new URLSearchParams(idp.seen.tokenBody ?? '');
    assert.equal(exchange.get('grant_type'), 'authorization_code');
    assert.ok((exchange.get('code_verifier') ?? '').length >= 43);
    // The verifier goes to the token endpoint and NOWHERE else — never into the authorize URL.
    assert.equal(idp.seen.authorize?.get('code_verifier'), null);
  } finally {
    idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: a callback with the wrong state is refused, and nothing is cached', async () => {
  // The attack: a local process (the agent shares this host's OS user) reaches the loopback
  // listener first with a code of its own.
  const idp = await provider();
  const dir = scratch();
  try {
    const path = join(dir, 'token-cache.json');
    const cache = new FileTokenCache(path);

    const result = await signIn(configFor(idp.port), cache, {
      present: (url) => {
        const redirect = new URL(new URL(url).searchParams.get('redirect_uri') ?? '');
        redirect.searchParams.set('code', 'an-attacker-code');
        redirect.searchParams.set('state', 'not-the-state-this-host-minted');
        void fetch(redirect.toString()).catch(() => undefined);
      },
      timeoutMs: 10_000,
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.refusal.reason : null, 'auth-state-mismatch');
    assert.equal(cache.read().ok, false, 'a token was cached from a callback this host did not request');
  } finally {
    idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a provider refusing the exchange surfaces its reason and caches nothing', async () => {
  const idp = await provider({
    tokenStatus: 400,
    tokenBody: { error: 'invalid_grant', error_description: 'code expired' },
  });
  const dir = scratch();
  try {
    const cache = new FileTokenCache(join(dir, 'token-cache.json'));

    const result = await signIn(configFor(idp.port), cache, { present: followRedirect, timeoutMs: 10_000 });

    // A refused exchange surfaces the provider's own reason and caches nothing. An `invalid_grant`
    // is its own reason rather than sharing one with an outage, because the two need opposite
    // responses and only one of them is worth retrying.
    assert.equal(result.ok === false ? result.refusal.reason : null, 'token-grant-rejected');
    assert.match(result.ok === false ? result.refusal.detail : '', /invalid_grant/);
    assert.equal(cache.read().ok, false);
  } finally {
    idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: a token in a real failing exchange never reaches the refusal detail', async () => {
  const secret = 'LEAKED-TOKEN-THROUGH-THE-REAL-FLOW';
  const idp = await provider({
    tokenStatus: 400,
    tokenBody: { error: 'invalid_grant', error_description: `bad ${secret}`, access_token: secret },
  });
  const dir = scratch();
  try {
    const result = await signIn(configFor(idp.port), new FileTokenCache(join(dir, 'token-cache.json')), {
      present: followRedirect,
      timeoutMs: 10_000,
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.ok === false ? result.refusal.detail.includes(secret) : true,
      false,
      result.ok === false ? result.refusal.detail : '',
    );
  } finally {
    idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a 2xx that is not a token response is token-response-invalid, not a success', async () => {
  const idp = await provider({ tokenStatus: 200, tokenBody: { hello: 'world' } });
  const dir = scratch();
  try {
    const result = await signIn(configFor(idp.port), new FileTokenCache(join(dir, 'token-cache.json')), {
      present: followRedirect,
      timeoutMs: 10_000,
    });

    assert.equal(result.ok === false ? result.refusal.reason : null, 'token-response-invalid');
  } finally {
    idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: the loopback port is released on the failure path too, not only on success', async () => {
  // A socket accepting authorization callbacks must not outlive the sign-in that opened it.
  const idp = await provider({ tokenStatus: 500, tokenBody: { error: 'server_error' } });
  const dir = scratch();
  try {
    let redirectUri = '';
    await signIn(configFor(idp.port), new FileTokenCache(join(dir, 'token-cache.json')), {
      present: (url) => {
        redirectUri = new URL(url).searchParams.get('redirect_uri') ?? '';
        followRedirect(url);
      },
      timeoutMs: 10_000,
    });

    await assert.rejects(
      () => fetch(redirectUri),
      'the loopback listener was still bound after a failed sign-in',
    );
  } finally {
    idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an abandoned sign-in times out and caches nothing', async () => {
  const idp = await provider();
  const dir = scratch();
  try {
    const cache = new FileTokenCache(join(dir, 'token-cache.json'));

    const result = await signIn(configFor(idp.port), cache, { present: () => {}, timeoutMs: 150 });

    assert.equal(result.ok === false ? result.refusal.reason : null, 'auth-callback-refused');
    assert.equal(cache.read().ok, false);
  } finally {
    idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The device-code fallback, against the same real local provider
// ---------------------------------------------------------------------------

/** A provider that speaks the device-code half: issue a code, say pending, then hand over a token. */
function deviceProvider(
  options: { pendingPolls?: number; slowDownFirst?: boolean; declineWith?: string } = {},
) {
  let polls = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    if (url.pathname === '/.well-known/openid-configuration') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          device_authorization_endpoint: `${base}/devicecode`,
        }),
      );
      return;
    }

    if (url.pathname === '/devicecode') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          device_code: 'dc',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://example/devicelogin',
          expires_in: 900,
          interval: 1,
        }),
      );
      return;
    }

    if (url.pathname === '/token') {
      request.on('data', () => {});
      request.on('end', () => {
        polls += 1;
        const json = (status: number, body: unknown): void => {
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(body));
        };
        if (options.declineWith !== undefined) return json(400, { error: options.declineWith });
        if (options.slowDownFirst === true && polls === 1) return json(400, { error: 'slow_down' });
        if (polls <= (options.pendingPolls ?? 0)) return json(400, { error: 'authorization_pending' });
        return json(200, {
          access_token: 'device-access-token',
          refresh_token: 'device-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      });
      return;
    }

    response.writeHead(404);
    response.end();
  });

  return new Promise<{ port: number; polls: () => number; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        polls: () => polls,
        close: () => {
          server.close();
          server.closeAllConnections?.();
        },
      });
    });
  });
}

const noSleep = async (): Promise<void> => {};

test('regression: the device-code flow refuses unless it was explicitly enabled', async () => {
  // The provider calls it a high-risk method and recommends blocking it. It must be asked for by
  // name, never arrived at by falling back when a browser is unavailable.
  const dir = scratch();
  try {
    const result = await signInWithDeviceCode(
      configFor(1),
      new FileTokenCache(join(dir, 'token-cache.json')),
      () => {},
      {
        fetch: () => {
          throw new Error('the provider was contacted although the flow is disabled');
        },
      },
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.refusal.reason : null, 'device-code-not-enabled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: a whole device-code sign-in: issue, poll through pending, redeem, cache, stamped device-code', async () => {
  const idp = await deviceProvider({ pendingPolls: 2 });
  const dir = scratch();
  try {
    const cache = new FileTokenCache(join(dir, 'token-cache.json'));
    const instructed: DeviceCodeInstruction[] = [];

    const result = await signInWithDeviceCode(
      configFor(idp.port, { deviceCodeEnabled: true }),
      cache,
      (instruction) => instructed.push(instruction),
      { sleep: noSleep, nowMs: () => NOW },
    );

    assert.ok(result.ok, result.ok === false ? result.refusal.detail : '');
    assert.equal(result.value.tokens.accessToken, 'device-access-token');
    // The stamp is what makes the AADSTS530036 guard possible at all.
    assert.equal(result.value.protocol, 'device-code');
    assert.equal(instructed[0]?.userCode, 'ABCD-EFGH');
    assert.ok(idp.polls() >= 3, `only ${idp.polls()} polls — the pending responses were not followed`);
  } finally {
    idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: the operator is told the code and the URL before the wait starts', async () => {
  // Instructing after the poll loop would leave a headless box silent for the whole sign-in.
  const idp = await deviceProvider({ pendingPolls: 1 });
  const dir = scratch();
  try {
    const order: string[] = [];
    await signInWithDeviceCode(
      configFor(idp.port, { deviceCodeEnabled: true }),
      new FileTokenCache(join(dir, 'token-cache.json')),
      () => order.push('instructed'),
      {
        sleep: async () => {
          order.push('waited');
        },
        nowMs: () => NOW,
      },
    );

    assert.equal(order[0], 'instructed', `order was ${order.join(' -> ')}`);
  } finally {
    idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('slow_down widens the interval rather than ending the sign-in', async () => {
  const idp = await deviceProvider({ slowDownFirst: true });
  const dir = scratch();
  try {
    const waits: number[] = [];
    const result = await signInWithDeviceCode(
      configFor(idp.port, { deviceCodeEnabled: true }),
      new FileTokenCache(join(dir, 'token-cache.json')),
      () => {},
      {
        sleep: async (ms) => {
          waits.push(ms);
        },
        nowMs: () => NOW,
      },
    );

    assert.ok(result.ok, result.ok === false ? result.refusal.detail : '');
    assert.ok((waits[1] ?? 0) > (waits[0] ?? 0), `intervals did not widen: ${waits.join(', ')}`);
  } finally {
    idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tenant declining the flow is a named refusal, and nothing is cached', async () => {
  const idp = await deviceProvider({ declineWith: 'access_denied' });
  const dir = scratch();
  try {
    const cache = new FileTokenCache(join(dir, 'token-cache.json'));

    const result = await signInWithDeviceCode(
      configFor(idp.port, { deviceCodeEnabled: true }),
      cache,
      () => {},
      { sleep: noSleep, nowMs: () => NOW },
    );

    assert.equal(result.ok === false ? result.refusal.reason : null, 'device-code-declined');
    assert.equal(cache.read().ok, false);
  } finally {
    idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a provider advertising no device endpoint refuses rather than guessing a URL', async () => {
  const idp = await provider(); // the loopback-only provider: no device_authorization_endpoint
  const dir = scratch();
  try {
    const result = await signInWithDeviceCode(
      configFor(idp.port, { deviceCodeEnabled: true }),
      new FileTokenCache(join(dir, 'token-cache.json')),
      () => {},
      { sleep: noSleep },
    );

    assert.equal(result.ok === false ? result.refusal.reason : null, 'device-code-declined');
  } finally {
    idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: a device-code cache is then refused by a host configured for loopback', async () => {
  // The two halves meeting: device code stamps the cache, and the credential's AADSTS530036 guard
  // reads that stamp. Neither test alone shows the loop closing.
  const idp = await deviceProvider();
  const dir = scratch();
  try {
    const cache = new FileTokenCache(join(dir, 'token-cache.json'));
    await signInWithDeviceCode(configFor(idp.port, { deviceCodeEnabled: true }), cache, () => {}, {
      sleep: noSleep,
      nowMs: () => NOW,
    });

    const loopbackHost = new TokenCredential({
      store: cache,
      config: configFor(idp.port),
      protocol: 'loopback',
      nowMs: () => NOW,
    });
    const presented = await loopbackHost.authorize();

    assert.equal(presented.ok, false);
    assert.match(presented.ok === false ? presented.refusal.detail : '', /device-code/);
    assert.equal(cache.read().ok, false, 'the cross-protocol cache was left on disk');
  } finally {
    idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test('stated endpoints skip discovery entirely — no round trip an operator did not ask for', async () => {
  const stated = {
    authorizationEndpoint: 'https://x/authorize',
    tokenEndpoint: 'https://x/token',
    deviceAuthorizationEndpoint: null,
  };

  const result = await resolveEndpoints(configFor(1, { endpoints: stated }), () => {
    throw new Error('discovery was attempted although the endpoints were stated');
  });

  assert.ok(result.ok);
  assert.equal(result.value.tokenEndpoint, 'https://x/token');
});

test("discovery reads the provider's real document", async () => {
  const idp = await provider();
  try {
    const result = await resolveEndpoints(configFor(idp.port));

    assert.ok(result.ok, result.ok === false ? result.refusal.detail : '');
    assert.match(result.value.tokenEndpoint, /\/token$/);
  } finally {
    idp.close();
  }
});

test('an unreachable provider is a named refusal, never a thrown error', async () => {
  // A host that crashes on a DNS failure is one an operator cannot diagnose.
  const result = await resolveEndpoints(configFor(1));

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.refusal.reason : null, 'identity-config-invalid');
});

// ---------------------------------------------------------------------------
// Refresh, and the whole loop through the credential
// ---------------------------------------------------------------------------

test('regression: sign in, expire, refresh, present: the complete loop against a real provider', async () => {
  const idp = await provider();
  const dir = scratch();
  try {
    const config = configFor(idp.port);
    const cache = new FileTokenCache(join(dir, 'token-cache.json'));

    const signedIn = await signIn(config, cache, {
      present: followRedirect,
      nowMs: () => NOW,
      timeoutMs: 10_000,
    });
    assert.ok(signedIn.ok);

    const endpoints = await resolveEndpoints(config);
    assert.ok(endpoints.ok);

    // A clock past the token's expiry forces the refresh path.
    const credential = new TokenCredential({
      store: cache,
      config,
      protocol: 'loopback',
      nowMs: () => NOW + 7_200_000,
      refresh: refresherFor(config, endpoints.value, cache, { nowMs: () => NOW + 7_200_000 }),
    });

    const presented = await credential.authorize();

    assert.ok(presented.ok, presented.ok === false ? presented.refusal.detail : '');
    assert.equal(presented.value.header, 'Authorization');
    assert.match(presented.value.value, /^Bearer /);
    // The refreshed token was persisted, so a restart does not need another sign-in.
    assert.ok(cache.read().ok);
  } finally {
    idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: AADSTS530036 on a refresh discards the cache instead of retrying it forever', async () => {
  // The provider says the material can never be refreshed. Retrying is guaranteed to fail on every
  // start, silently, until somebody looks; clearing turns that into one sign-in.
  const idp = await provider({
    tokenStatus: 400,
    tokenBody: {
      error: 'invalid_grant',
      error_description: 'AADSTS530036: the token will never be usable and should be deleted',
    },
  });
  const dir = scratch();
  try {
    const config = configFor(idp.port);
    const cache = new FileTokenCache(join(dir, 'token-cache.json'));
    cache.write({
      tokens: {
        accessToken: 'stale',
        refreshToken: 'stale-refresh',
        expiresAt: NOW - 1,
        tokenType: 'Bearer',
        scope: null,
      },
      protocol: 'loopback',
      authority: config.authority,
      clientId: config.clientId,
    });

    const endpoints = {
      authorizationEndpoint: `http://127.0.0.1:${idp.port}/authorize`,
      tokenEndpoint: `http://127.0.0.1:${idp.port}/token`,
      deviceAuthorizationEndpoint: null,
    };
    const refresh = refresherFor(config, endpoints, cache, { nowMs: () => NOW });

    const result = await refresh(
      cache.read().ok ? (cache.read() as { ok: true; value: never }).value : (null as never),
    );

    assert.equal(result.ok, false);
    assert.equal(cache.read().ok, false, 'the permanently-unusable cache was left on disk');
  } finally {
    idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refresh with no refresh token refuses rather than calling the provider', async () => {
  const config = configFor(1);
  const refresh = refresherFor(
    config,
    { authorizationEndpoint: 'https://x/a', tokenEndpoint: 'https://x/t', deviceAuthorizationEndpoint: null },
    {
      read: () => {
        throw new Error('unused');
      },
      write: () => {
        throw new Error('unused');
      },
      clear: () => {},
    },
    {
      fetch: () => {
        throw new Error('the provider was called although there was nothing to refresh with');
      },
    },
  );

  const result = await refresh({
    tokens: { accessToken: 'a', refreshToken: null, expiresAt: 0, tokenType: 'Bearer', scope: null },
    protocol: 'loopback',
    authority: config.authority,
    clientId: config.clientId,
  });

  assert.equal(result.ok === false ? result.refusal.reason : null, 'token-unavailable');
});

// ---------------------------------------------------------------------------
// The recovery must not return to the flow that produced the failure.
//
// `AADSTS530036` is a Conditional Access authentication-flows refusal, not a cross-protocol
// refresh (see `identity/device-code.ts`). The trigger is a tenant admin enabling the policy
// Microsoft itself recommends. A refusal saying "sign in again" would loop: `protocolFor` derives
// the flow from static config, so "again" would mean the same device-code flow into the same
// policy, unattended, forever. These two tests pin that the refusal names a way out of the loop.
// ---------------------------------------------------------------------------

const BLOCKED_BODY = {
  error: 'invalid_grant',
  error_description: 'AADSTS530036: the token will never be usable and should be deleted',
};

async function refreshUnderBlockedPolicy(deviceCodeEnabled: boolean): Promise<string> {
  const idp = await provider({ tokenStatus: 400, tokenBody: BLOCKED_BODY });
  const dir = scratch();
  try {
    const config = configFor(idp.port, { deviceCodeEnabled });
    const cache = new FileTokenCache(join(dir, 'token-cache.json'));
    cache.write({
      tokens: {
        accessToken: 'stale',
        refreshToken: 'stale-refresh',
        expiresAt: NOW - 1,
        tokenType: 'Bearer',
        scope: null,
      },
      protocol: deviceCodeEnabled ? 'device-code' : 'loopback',
      authority: config.authority,
      clientId: config.clientId,
    });
    const endpoints = {
      authorizationEndpoint: `http://127.0.0.1:${idp.port}/authorize`,
      tokenEndpoint: `http://127.0.0.1:${idp.port}/token`,
      deviceAuthorizationEndpoint: `http://127.0.0.1:${idp.port}/devicecode`,
    };
    const cached = cache.read();
    const result = await refresherFor(config, endpoints, cache, { nowMs: () => NOW })(
      cached.ok ? cached.value : (null as never),
    );

    assert.equal(result.ok, false, 'a policy-blocked refresh reported success');
    assert.equal(cache.read().ok, false, 'the permanently-unusable cache was left on disk');
    return result.ok ? '' : result.refusal.detail;
  } finally {
    idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('regression: a 530036 under device code names loopback as the way out; it never says "sign in again"', async () => {
  const detail = await refreshUnderBlockedPolicy(true);

  // The loop, closed: the operator is told the blocked flow by name and given the unblocked one.
  assert.match(detail, /DEVICE CODE/, 'the refusal does not name the flow that is blocked');
  assert.match(
    detail,
    /deviceCodeEnabled: false/,
    'the refusal does not name the setting that escapes the loop',
  );
  assert.match(detail, /loopback/i, 'the refusal does not point at the flow this package already implements');

  // The anti-assertion, and it is the point of the test. "Sign in again" is precisely the
  // instruction that re-enters the failing flow, so its absence is the property.
  assert.doesNotMatch(
    detail,
    /sign in again/i,
    'the refusal still invites a retry of the flow that just failed',
  );
});

test('regression: a 530036 already on loopback refuses by name rather than naming a fallback that does not exist', async () => {
  // Nothing left to fall back to. A refusal that named loopback here would be the same loop relabelled.
  const detail = await refreshUnderBlockedPolicy(false);

  assert.match(detail, /ALREADY configured for the loopback flow/, 'the refusal pretends a fallback exists');
  assert.match(detail, /provider's administrator/, 'the refusal does not say who can actually fix this');
  assert.doesNotMatch(detail, /sign in again/i);
});
