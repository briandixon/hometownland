/**
 * The shared Redis store, for the endpoints that need more than one command.
 *
 * Not a route: Vercel does not publish files under /api whose names start
 * with an underscore, the same as _bot-rules.js.
 *
 * Same store, same variable names and same two ways in as call-relay.js and
 * track.js, which each carry their own copy of this so that neither can be
 * broken by an edit made for the other. New code (/api/desk and the texts
 * the relay sends) shares this one.
 *
 *   KV_REST_API_URL        + KV_REST_API_TOKEN          (Vercel KV, HTTPS)
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN   (Upstash, HTTPS)
 *   REDIS_URL / KV_URL                                  (any Redis, TCP)
 */

import net from "node:net";
import tls from "node:tls";

/** An HTTPS-addressable store, or null. */
function restStore() {
  const env = process.env;
  const pairs = [
    [env.KV_REST_API_URL, env.KV_REST_API_TOKEN, "vercel-kv"],
    [env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN, "upstash"],
  ];
  for (const [url, token, name] of pairs) {
    if (url && token) {
      return { kind: "rest", name, url: String(url).replace(/\/+$/, ""), token };
    }
  }
  return null;
}

/** A redis:// or rediss:// URL, or null. */
function wireStore() {
  const raw = process.env.REDIS_URL || process.env.KV_URL;
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "redis:" && u.protocol !== "rediss:") return null;
  return {
    kind: "wire",
    name: "redis",
    host: u.hostname,
    port: Number(u.port) || 6379,
    secure: u.protocol === "rediss:",
    username: decodeURIComponent(u.username || ""),
    password: decodeURIComponent(u.password || ""),
  };
}

export function kv() {
  return restStore() || wireStore();
}

/** Encode one command in the Redis wire format. */
function resp(args) {
  let out = `*${args.length}\r\n`;
  for (const a of args) {
    const s = String(a);
    out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
  }
  return out;
}

/** Read one RESP value starting at `i`, returning it with the offset after it. */
function parseValue(buf, i) {
  if (i >= buf.length) return null;
  const type = buf[i];
  const nl = buf.indexOf("\r\n", i);
  if (nl === -1) return null;
  const head = buf.slice(i + 1, nl).toString();

  if (type === 0x2b) return { value: head, next: nl + 2 };            // +status
  if (type === 0x3a) return { value: Number(head), next: nl + 2 };    // :integer
  if (type === 0x2d) return { value: null, next: nl + 2 };            // -error
  if (type === 0x24) {                                                // $bulk
    const len = Number(head);
    if (!Number.isFinite(len) || len < 0) return { value: null, next: nl + 2 };
    const start = nl + 2;
    // Sliced as bytes and decoded once: an owner's name with an accent in it
    // is two bytes, and the length the server sends counts bytes.
    return { value: buf.slice(start, start + len).toString("utf8"), next: start + len + 2 };
  }
  if (type === 0x2a) {                                                // *array
    const count = Number(head);
    let at = nl + 2;
    if (!Number.isFinite(count) || count < 0) return { value: null, next: at };
    const items = [];
    for (let k = 0; k < count; k++) {
      const got = parseValue(buf, at);
      if (!got) return null;
      items.push(got.value);
      at = got.next;
    }
    return { value: items, next: at };
  }
  return null;                                                        // not ours
}

function parseReplies(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const got = parseValue(buf, i);
    if (!got) break;
    out.push(got.value);
    i = got.next;
  }
  return out;
}

/**
 * Run a batch of commands against a redis:// store over one socket.
 *
 * AUTH, every command and QUIT go out in a single write, and the server
 * hanging up is the signal to parse. Failure resolves null, never throws.
 */
function wireBatch(store, commands, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const chunks = [];
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(value);
    };

    const onReady = () => {
      const pipeline = [];
      if (store.password) {
        pipeline.push(store.username
          ? ["AUTH", store.username, store.password]
          : ["AUTH", store.password]);
      }
      pipeline.push(...commands, ["QUIT"]);
      socket.write(pipeline.map(resp).join(""));
    };

    const options = { host: store.host, port: store.port };
    const socket = store.secure
      ? tls.connect({ ...options, servername: store.host }, onReady)
      : net.connect(options, onReady);

    socket.setTimeout(timeoutMs, () => finish(null));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", () => finish(null));
    socket.on("end", () => {
      const replies = parseReplies(Buffer.concat(chunks));
      // One reply per command, then QUIT's +OK. Fewer than that means the
      // connection was cut short, and a partial answer would be read as
      // "not found" further up.
      const skip = store.password ? 1 : 0;
      if (replies.length < skip + commands.length) return finish(null);
      finish(replies.slice(skip, skip + commands.length));
    });
  });
}

/**
 * Run a batch of commands against whichever store is configured.
 *
 * Resolves to one reply per command (null where a command failed), or null
 * when the store could not be reached at all.
 */
export async function batch(store, commands, timeoutMs = 8000) {
  if (!store || !commands.length) return null;

  if (store.kind === "wire") return wireBatch(store, commands, timeoutMs);

  try {
    const res = await fetch(`${store.url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${store.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands.map((c) => c.map(String))),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!Array.isArray(body)) return null;
    return body.map((r) => (r && "result" in r ? r.result : null));
  } catch {
    return null;
  }
}

/** Timing-safe string compare, so a secret cannot be guessed a character at a time. */
export function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
