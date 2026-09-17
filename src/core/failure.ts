/**
 * Describing a thrown failure so the reader learns the cause, not the wrapper.
 *
 * Node's `fetch` throws `TypeError: fetch failed` and puts the reason on `error.cause`; a WebSocket
 * carries a `code` such as `DEPTH_ZERO_SELF_SIGNED_CERT`. A message that stops at the wrapper reads
 * "could not be reached" for a controller that answered the TCP dial and refused nothing but its own
 * certificate. So the nested causes are walked, the innermost code is named, and a certificate refusal
 * carries the remedy, because it is the failure a local controller meets first.
 */

/** The `code` a Node error carries when TLS refused the peer's certificate. */
const CERTIFICATE_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|CERTIFICATE/;

/** The innermost error under nested `cause` members, and the codes met on the way down. */
function unwrap(error: unknown): { readonly leaf: unknown; readonly codes: string[] } {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      typeof current === 'object' &&
      current !== null &&
      typeof (current as { code?: unknown }).code === 'string'
    ) {
      codes.push((current as { code: string }).code);
    }
    const next =
      typeof current === 'object' && current !== null ? (current as { cause?: unknown }).cause : undefined;
    if (next === undefined || next === null) break;
    current = next;
  }
  return { leaf: current, codes };
}

/** Is this failure TLS refusing the peer's certificate? Read off every `code` met on the way down. */
export function isCertificateRefusal(error: unknown): boolean {
  return unwrap(error).codes.some((code) => CERTIFICATE_CODES.test(code));
}

/**
 * The failure in one line: the innermost message, prefixed by the innermost code when there is one.
 * `fetch failed` becomes `DEPTH_ZERO_SELF_SIGNED_CERT: self-signed certificate`.
 */
export function describeFailure(error: unknown): string {
  const { leaf, codes } = unwrap(error);
  const message = leaf instanceof Error ? leaf.message : typeof leaf === 'string' ? leaf : String(leaf);
  const code = codes.at(-1);
  return code === undefined || message.includes(code) ? message : `${code}: ${message}`;
}

/**
 * What to do about a certificate refusal, in the operator's words. Stated once, here, so the pair
 * verb, the decision transport and the link say the same thing.
 */
export function certificateRemedy(where: string): string {
  return (
    `Node does not trust the certificate ${where} presents. For a controller on a development ` +
    `certificate, export that certificate as PEM and point Node at it: set NODE_EXTRA_CA_CERTS to the ` +
    `file's path, then run this command again in a new terminal. Disabling verification ` +
    `(NODE_TLS_REJECT_UNAUTHORIZED=0) also works and trusts every certificate; prefer the file.`
  );
}
