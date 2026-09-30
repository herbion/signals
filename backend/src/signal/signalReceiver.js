import { handleInboundMessage } from './inboundMessageHandler.js';
import { signalFetch } from './signalHttp.js';

/**
 * Inbound Signal receiver.
 *
 * signal-cli-rest-api serves `/v1/receive/{number}` two different ways
 * depending on the container's MODE:
 *   - normal / native  -> plain `GET`, returns an array of envelopes
 *   - json-rpc*        -> a WEBSOCKET on the same path; the GET returns 400
 *
 * docker-compose.yml runs a json-rpc mode, so the original GET-polling
 * implementation could never receive anything -- it just logged
 * `GET /v1/receive failed: 400` every interval forever. `receive_transport`
 * = 'auto' asks `/v1/about` which mode is actually running and picks the
 * matching transport; the explicit values exist for when the probe can't be
 * trusted (e.g. a proxy in front of the container).
 *
 * A supervisor re-reads settings on a short interval so toggling receive on
 * or off, or switching transport, takes effect without restarting the app --
 * the same property the old poller had.
 */

const SUPERVISOR_INTERVAL_MS = 5000;
const MAX_BACKOFF_MS = 30000;

let supervisorTimer = null;
let current = null; // { signature, stop() }

export function startSignalReceiver(db) {
  stopSignalReceiver();
  const tick = () => {
    try {
      reconcile(db);
    } catch (err) {
      console.error('Signal receiver supervisor failed:', err.message);
    } finally {
      supervisorTimer = setTimeout(tick, SUPERVISOR_INTERVAL_MS);
    }
  };
  supervisorTimer = setTimeout(tick, 1000);
}

export function stopSignalReceiver() {
  if (supervisorTimer) clearTimeout(supervisorTimer);
  supervisorTimer = null;
  if (current) {
    current.stop();
    current = null;
  }
}

/** Everything that, if changed, means the running connection is now wrong. */
function settingsSignature(settings) {
  if (!settings?.receive_enabled || !settings.bot_number) return 'off';
  return [
    settings.receive_transport,
    settings.bot_number,
    settings.signal_api_base_url,
    settings.poll_interval_seconds,
  ].join('|');
}

function reconcile(db) {
  const settings = db.prepare('SELECT * FROM signal_settings WHERE id = 1').get();
  const signature = settingsSignature(settings);
  if (current?.signature === signature) return;

  if (current) {
    current.stop();
    current = null;
  }
  if (signature === 'off') {
    // Remember the off state too, so the next tick is a no-op instead of
    // re-deriving it from the database every 5 seconds.
    current = { signature, stop() {} };
    return;
  }

  // 'webhook' means an external process pushes to /webhooks/signal; there is
  // nothing for this side to connect to.
  if (settings.receive_transport === 'webhook') {
    current = { signature, stop() {} };
    return;
  }

  current = { signature, ...startTransport(db, settings) };
}

function startTransport(db, settings) {
  let stopped = false;
  let socket = null;
  let timer = null;
  let backoffMs = 2000;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const runPoll = async () => {
    if (stopped) return;
    try {
      await pollOnce(db, settings);
    } catch (err) {
      console.error('Signal receive poll failed:', err.message);
    } finally {
      if (!stopped) {
        timer = setTimeout(runPoll, Math.max(1, settings.poll_interval_seconds ?? 10) * 1000);
      }
    }
  };

  const connectWebsocket = () => {
    if (stopped) return;
    const url = receiveWebsocketUrl(settings.signal_api_base_url, settings.bot_number);
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error('Signal receive websocket could not be created:', err.message);
      timer = setTimeout(connectWebsocket, backoffMs);
      backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
      return;
    }
    socket = ws;

    // Node's WebSocket does NOT reliably follow a failed-connection 'error'
    // with a 'close' -- observed in practice: a DNS failure or connection
    // refusal fires 'error' only. Reconnect must therefore be scheduled from
    // either event, guarded so a normal drop (which can fire both) doesn't
    // schedule twice.
    let reconnectScheduled = false;
    const scheduleReconnect = () => {
      socket = null;
      if (stopped || reconnectScheduled) return;
      reconnectScheduled = true;
      timer = setTimeout(connectWebsocket, backoffMs);
      backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
    };

    ws.addEventListener('open', () => {
      backoffMs = 2000;
      console.log(`Signal receive websocket connected (${url})`);
    });

    ws.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return; // keepalives and other non-JSON frames
      }
      for (const envelope of envelopesFrom(payload)) {
        handleInboundMessage(db, envelope).catch((err) =>
          console.error('Inbound message handling failed:', err.message)
        );
      }
    });

    ws.addEventListener('error', (event) => {
      console.error('Signal receive websocket error:', event?.message ?? event?.error?.message ?? 'unknown');
      scheduleReconnect();
    });

    ws.addEventListener('close', scheduleReconnect);
  };

  const begin = async () => {
    let transport = settings.receive_transport;
    if (transport === 'auto') {
      transport = await detectTransport(settings.signal_api_base_url);
    }
    if (stopped) return;
    if (transport === 'websocket') connectWebsocket();
    else runPoll();
  };

  begin().catch((err) => console.error('Signal receiver failed to start:', err.message));

  return {
    stop() {
      stopped = true;
      clearTimer();
      if (socket) {
        try {
          socket.close();
        } catch {
          // already closing
        }
        socket = null;
      }
    },
  };
}

/**
 * `/v1/about` reports the container's MODE. json-rpc modes serve
 * /v1/receive as a websocket; normal/native serve it as a GET.
 * If the probe fails we assume websocket, because that is what the
 * docker-compose default (json-rpc-native) needs -- guessing poll there
 * reproduces exactly the 400-loop this replaced.
 */
export async function detectTransport(baseUrl) {
  try {
    const response = await signalFetch(`${baseUrl}/v1/about`);
    if (!response.ok) throw new Error(`status ${response.status}`);
    const about = await response.json();
    const mode = String(about?.mode ?? '');
    return mode.startsWith('json-rpc') ? 'websocket' : 'poll';
  } catch (err) {
    console.error('Could not detect signal-cli-rest-api mode, assuming websocket:', err.message);
    return 'websocket';
  }
}

export function receiveWebsocketUrl(baseUrl, botNumber) {
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/v1/receive/${encodeURIComponent(botNumber)}`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/**
 * The websocket delivers a single `{envelope}` object; the GET endpoint
 * delivers an array of them. Accept either, plus a bare envelope, so the two
 * transports and the inbound webhook all feed the same handler.
 */
export function envelopesFrom(payload) {
  const items = Array.isArray(payload) ? payload : [payload];
  return items
    .map((item) => item?.envelope ?? (item?.dataMessage || item?.source || item?.sourceNumber ? item : null))
    .filter(Boolean);
}

async function pollOnce(db, settings) {
  const response = await signalFetch(
    `${settings.signal_api_base_url}/v1/receive/${encodeURIComponent(settings.bot_number)}`
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GET /v1/receive failed: ${response.status} ${body.slice(0, 200)}`);
  }
  const results = await response.json();
  for (const envelope of envelopesFrom(results)) {
    await handleInboundMessage(db, envelope).catch((err) =>
      console.error('Inbound message handling failed:', err.message)
    );
  }
}
