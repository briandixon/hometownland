/**
 * /api/call-relay — hands an inbound Quo call to the Call Desk running on a desktop.
 *
 * The Call Desk lives on a laptop and has no public address, so Quo cannot
 * reach it. This endpoint is the only public part: Quo posts a ringing event
 * here, the desk asks here for the latest one. Nothing reaches into the
 * laptop — the desk always dials out.
 *
 * Only a caller's phone number passes through, for a minute at most. Mailer
 * files, owner names and offer prices stay on the desktop and are never sent
 * here.
 *
 *   POST /api/call-relay?key=SECRET   Quo webhook target (event: call.ringing)
 *   GET  /api/call-relay?key=SECRET   the desk, asking "anyone calling?"
 *
 * Environment variables (Vercel > Project > Settings > Environment Variables):
 *   CALL_RELAY_KEY    Required. Shared secret. Without it the endpoint is off.
 *   QUO_INBOX_ID      Optional. Only accept calls to this inbox. Default PNu6laiBJX.
 *   KV_REST_API_URL   Optional but recommended, set for you when you add
 *   KV_REST_API_TOKEN Upstash Redis from the Vercel dashboard. Without a store
 *                     the event is held in memory, which only works when the
 *                     POST and the GET happen to hit the same instance.
 */

const EVENT_KEY = "calldesk:ringing";
const EVENT_TTL = 90; // seconds; a call not collected by then is stale anyway

// Fallback when no store is configured. Survives only within one instance.
let memory = null;

function kv() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function put(event) {
  const store = kv();
  if (!store) {
    memory = event;
    return "memory";
  }
  await fetch(`${store.url}/set/${EVENT_KEY}?EX=${EVENT_TTL}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${store.token}` },
    body: JSON.stringify(event),
  });
  return "store";
}

async function take() {
  const store = kv();
  if (!store) return memory;
  const res = await fetch(`${store.url}/get/${EVENT_KEY}`, {
    headers: { Authorization: `Bearer ${store.token}` },
  });
  if (!res.ok) return null;
  const body = await res.json();
  if (!body || body.result == null) return null;
  try {
    return typeof body.result === "string" ? JSON.parse(body.result) : body.result;
  } catch {
    return null;
  }
}

/** Timing-safe string compare, so the secret cannot be guessed a character at a time. */
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Ten digits, the form the mailer files are indexed by. */
function tenDigits(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length === 10 ? d : "";
}

/**
 * Pull the call out of a Quo event.
 *
 * Confirmed against a real call.ringing payload, apiVersion v3:
 *   { object: { type, data: { object: <call> } } }
 *
 * The other party is `from` on an incoming call but `to` on an outgoing one,
 * so direction has to be read before picking a number — otherwise every call
 * you place pops a card for your own line.
 */
function readCall(payload) {
  const ev = payload && payload.object && payload.object.object === "event"
    ? payload.object
    : payload;
  const call = ev && ev.data && ev.data.object;
  if (!call) return null;

  const incoming = call.direction === "incoming";
  return {
    type: ev.type || "",
    direction: call.direction || "",
    status: call.status || "",
    caller: tenDigits(incoming ? call.from : call.to),
    line: tenDigits(incoming ? call.to : call.from),
    callId: call.id || "",
    conversationId: call.conversationId || "",
    inboxId: call.phoneNumberId || "",
    at: call.createdAt || new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const secret = process.env.CALL_RELAY_KEY;
  if (!secret) {
    // Nothing configured yet: stay shut rather than relaying to anyone who asks.
    return res.status(503).json({ ok: false, error: "relay not configured" });
  }

  const url = new URL(req.url, `https://${req.headers.host}`);
  const offered = url.searchParams.get("key") || req.headers["x-relay-key"] || "";
  if (!sameSecret(offered, secret)) {
    return res.status(401).json({ ok: false, error: "bad key" });
  }

  // ---- the desk, asking whether anyone is calling ----
  if (req.method === "GET") {
    const event = await take();
    if (!event) return res.status(200).json({ ok: true, call: null });

    const age = (Date.now() - Date.parse(event.at)) / 1000;
    if (!Number.isFinite(age) || age > EVENT_TTL) {
      return res.status(200).json({ ok: true, call: null });
    }
    return res.status(200).json({ ok: true, call: event });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }

  // ---- Quo, reporting a call ----
  // Quo retries on a non-2xx, so anything we deliberately ignore still answers
  // 200. Only a genuine failure on our side should look like a failure.
  let payload = req.body;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return res.status(200).json({ ok: true, ignored: "unparseable body" });
    }
  }

  const call = readCall(payload);
  if (!call) return res.status(200).json({ ok: true, ignored: "no call object" });
  if (call.type !== "call.ringing") return res.status(200).json({ ok: true, ignored: call.type });
  if (call.direction !== "incoming") return res.status(200).json({ ok: true, ignored: "outgoing" });

  const inbox = process.env.QUO_INBOX_ID || "PNu6laiBJX";
  if (call.inboxId && call.inboxId !== inbox) {
    return res.status(200).json({ ok: true, ignored: "other inbox" });
  }
  if (!call.caller) return res.status(200).json({ ok: true, ignored: "withheld number" });

  const where = await put(call);
  return res.status(200).json({ ok: true, held: where });
}
