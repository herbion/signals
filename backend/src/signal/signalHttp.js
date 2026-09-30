/**
 * The one way this app talks HTTP to signal-cli-rest-api.
 *
 * **A request to that API can hang forever.** In the json-rpc modes it is a
 * thin front for a signal-cli daemon it talks to over JSON-RPC; when that
 * daemon dies mid-request -- which it does, see the reaction quirk in
 * CLAUDE.md -- the HTTP handler goes on waiting for a reply that will never
 * come. Node's fetch would sit on that for its default 300s headersTimeout,
 * and since inbound work runs in sequence, one wedged call stalls everything
 * queued behind it: a hung reaction delayed the ticket for that same message
 * by five minutes. A bounded deadline turns that into a fast, logged failure
 * that the rest of the pipeline runs past.
 *
 * Failures are deliberately **not retried**. Retrying a request that killed
 * the daemon just kills it again and doubles the outage -- which is exactly
 * what an earlier "transient blip" retry here did.
 *
 * fetch() also reports every transport failure as a bare "fetch failed" with
 * the real reason hidden on `err.cause`, so the cause is unwrapped here.
 * Otherwise that useless string is what reaches the dashboard and the failure
 * notice a human gets on Signal.
 */

// Long enough for a slow group send (the slowest observed /v2/send was ~6s),
// short enough that a wedged signal-cli cannot stall the pipeline behind it.
export const REQUEST_TIMEOUT_MS = 30_000;

export async function signalFetch(url, options = {}) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    const reason =
      err.name === 'TimeoutError'
        ? `no response in ${REQUEST_TIMEOUT_MS / 1000}s -- signal-cli-rest-api accepted the request but never answered (is signal-cli alive?)`
        : err.cause?.message ?? err.message;
    throw new Error(`signal-cli-rest-api ${new URL(url).pathname} failed: ${reason}`);
  }
}
