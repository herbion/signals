import crypto from 'node:crypto';

/**
 * OpenProject signs webhook bodies as `sha1=<hexHmac>` (algorithm chosen in
 * the webhook admin UI, sha1 or sha256) in the `X-OP-Signature` header,
 * HMAC'd over the raw request body with the configured secret. Verify
 * against whichever algorithm prefix is present.
 */
export function verifySignature(rawBody, header, secret) {
  if (!secret) return false;
  if (!header || typeof header !== 'string') return false;

  const [algo, providedDigest] = header.includes('=') ? header.split('=', 2) : ['sha1', header];
  if (!providedDigest) return false;

  let expected;
  try {
    expected = crypto.createHmac(algo, secret).update(rawBody).digest('hex');
  } catch {
    return false; // unsupported algorithm name in header
  }

  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(providedDigest, 'hex');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}
