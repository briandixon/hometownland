/**
 * /api/desk — the cloud side of the Call Desk, for your phone.
 *
 * The laptop desk keeps the mailer records on the laptop. This keeps a copy on
 * the site, in the project's own Redis, so the /desk page works from a phone
 * with the laptop shut, and so the relay can text you a caller's card. The
 * laptop refreshes the copy every time it starts or reloads its folder.
 *
 *   POST /api/desk?op=sync     the laptop, sending one batch of records
 *   POST /api/desk?op=commit   the laptop: that sync is complete, make it live
 *   GET  /api/desk?op=meta     the phone: what is synced, recent calls, ringing
 *   GET  /api/desk?op=part     the phone: one page of records (&gen=&p=)
 *   POST /api/desk?op=text     the phone: text me this card
 *
 * Two keys, both sent as headers so neither lands in a log:
 *   x-relay-key   CALL_RELAY_KEY -- the laptop already holds it in config.json
 *   x-desk-key    DESK_KEY, the password the /desk page asks for. Falls back
 *                 to CALL_RELAY_KEY when DESK_KEY is not set.
 *
 * The copy holds owner names, phone numbers and offers. It lives only in the
 * Redis attached to this project -- never in the repository, which is public
 * -- and every read of it needs the desk key.
 */

import { kv, batch, sameSecret } from "./_store.js";
import {
  META_KEY, RECENT_KEY, RINGING_KEY, PART_SIZE, STAGING_TTL, GEN_RE,
  leadKey, phoneKey, parseJSON, readMeta, leadByIndex, composeText, sendText,
  textingReady, tenDigits,
} from "./_desk.js";

const RING_TTL = 90;          // matches call-relay: a call older than this has stopped ringing
const MAX_BATCH = 500;        // records per sync request, well under the body limit

async function body(req) {
  let b = req.body;
  if (b && typeof b.byteLength === "number") b = b.toString("utf8");
  if (typeof b === "string") b = parseJSON(b);
  return b && typeof b === "object" ? b : {};
}

function fail(res, code, error) {
  return res.status(code).json({ ok: false, error });
}

/* ------------------------------------------------------------ the laptop */

async function sync(req, res, store) {
  const b = await body(req);
  const gen = String(b.gen || "");
  const offset = Number(b.offset);
  const leads = Array.isArray(b.leads) ? b.leads : null;
  if (!GEN_RE.test(gen)) return fail(res, 400, "bad gen");
  if (!Number.isInteger(offset) || offset < 0) return fail(res, 400, "bad offset");
  if (!leads || leads.length > MAX_BATCH) return fail(res, 400, "bad leads");
  if (!leads.length) return res.status(200).json({ ok: true, stored: 0 });

  const leadPairs = [];
  const phonePairs = [];
  leads.forEach((lead, i) => {
    const index = offset + i;
    leadPairs.push(String(index), JSON.stringify(lead || {}));
    for (const p of (lead && Array.isArray(lead.phones) ? lead.phones : [])) {
      const d = tenDigits(p && p.num);
      // Later batches overwrite earlier ones, and the laptop sends oldest
      // campaign first, so a re-mailed number points at the newest letter.
      if (d) phonePairs.push(d, String(index));
    }
  });

  const commands = [["HSET", leadKey(gen), ...leadPairs], ["EXPIRE", leadKey(gen), String(STAGING_TTL)]];
  if (phonePairs.length) {
    commands.push(["HSET", phoneKey(gen), ...phonePairs], ["EXPIRE", phoneKey(gen), String(STAGING_TTL)]);
  }
  const r = await batch(store, commands, 15000);
  if (!r || r.some((x) => x === null)) return fail(res, 502, "the store did not take the batch");
  return res.status(200).json({ ok: true, stored: leads.length });
}

async function commit(req, res, store) {
  const b = await body(req);
  const gen = String(b.gen || "");
  const records = Number(b.records);
  if (!GEN_RE.test(gen)) return fail(res, 400, "bad gen");
  if (!Number.isInteger(records) || records < 0) return fail(res, 400, "bad records");

  const check = await batch(store, [["HLEN", leadKey(gen)], ["GET", META_KEY]]);
  if (!check) return fail(res, 502, "store unreachable");
  const held = Number(check[0] || 0);
  if (held !== records) {
    // A batch went missing on the way. Leave the live copy as it was.
    return fail(res, 409, `expected ${records} records, the store has ${held}`);
  }
  const previous = parseJSON(check[1]);

  const files = (Array.isArray(b.files) ? b.files : []).slice(0, 200).map((f) => ({
    name: String((f && f.name) || "").slice(0, 200),
    records: Number(f && f.records) || 0,
  }));
  const meta = { gen, records, files, at: new Date().toISOString() };

  const commands = [
    ["PERSIST", leadKey(gen)],
    ["PERSIST", phoneKey(gen)],
    ["SET", META_KEY, JSON.stringify(meta)],
  ];
  if (previous && previous.gen && previous.gen !== gen) {
    commands.push(["DEL", leadKey(previous.gen), phoneKey(previous.gen)]);
  }
  const r = await batch(store, commands);
  if (!r || r[2] !== "OK") return fail(res, 502, "the store did not take the commit");
  return res.status(200).json({ ok: true, meta });
}

/* ------------------------------------------------------------- the phone */

async function overview(req, res, store) {
  const r = await batch(store, [
    ["GET", META_KEY],
    ["LRANGE", RECENT_KEY, "0", "-1"],
    ["GET", RINGING_KEY],
  ]);
  if (!r) return fail(res, 502, "store unreachable");

  const meta = parseJSON(r[0]);
  const recent = (Array.isArray(r[1]) ? r[1] : []).map(parseJSON).filter(Boolean);
  let ringing = parseJSON(r[2]);
  if (ringing) {
    const age = (Date.now() - Date.parse(ringing.at)) / 1000;
    ringing = Number.isFinite(age) && age <= RING_TTL
      ? { caller: ringing.caller, at: ringing.at, callId: ringing.callId || "" }
      : null;
  }
  return res.status(200).json({
    ok: true,
    store: store.name,
    synced: meta,
    parts: meta ? Math.ceil(meta.records / PART_SIZE) : 0,
    partSize: PART_SIZE,
    recent,
    ringing,
    texting: textingReady(),
  });
}

async function part(req, res, store, url) {
  const gen = String(url.searchParams.get("gen") || "");
  const p = Number(url.searchParams.get("p"));
  if (!GEN_RE.test(gen) || !Number.isInteger(p) || p < 0) return fail(res, 400, "bad page");

  const meta = await readMeta(store);
  // The laptop re-synced since the page loaded: start over on the new copy
  // rather than stitch two copies together.
  if (!meta || meta.gen !== gen) return fail(res, 409, "the records were re-synced, reload");

  const first = p * PART_SIZE;
  const last = Math.min(meta.records, first + PART_SIZE);
  if (first >= last) return res.status(200).json({ ok: true, gen, first, leads: [] });

  const fields = [];
  for (let i = first; i < last; i++) fields.push(String(i));
  const r = await batch(store, [["HMGET", leadKey(gen), ...fields]], 15000);
  if (!r || !Array.isArray(r[0])) return fail(res, 502, "store unreachable");
  return res.status(200).json({ ok: true, gen, first, leads: r[0].map(parseJSON) });
}

async function textMe(req, res, store) {
  if (!textingReady()) return fail(res, 503, "texting is not set up — add QUO_API_KEY and CALL_TEXT_TO");
  const b = await body(req);
  const gen = String(b.gen || "");
  const index = Number(b.index);
  if (!GEN_RE.test(gen) || !Number.isInteger(index) || index < 0) return fail(res, 400, "bad record");

  const meta = await readMeta(store);
  if (!meta || meta.gen !== gen) return fail(res, 409, "the records were re-synced, reload");
  const hit = await leadByIndex(store, gen, index);
  if (!hit) return fail(res, 404, "no such record");

  const sent = await sendText(composeText(hit.lead, { origin: `https://${req.headers.host}` }));
  if (!sent.sent) return fail(res, 502, sent.error);
  return res.status(200).json({ ok: true, sent: true });
}

/* ------------------------------------------------------------ the router */

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  const relayKey = process.env.CALL_RELAY_KEY || "";
  const deskKey = process.env.DESK_KEY || relayKey;
  if (!deskKey) return fail(res, 503, "desk not configured — set DESK_KEY or CALL_RELAY_KEY");

  const url = new URL(req.url, `https://${req.headers.host}`);
  const op = url.searchParams.get("op") || "";
  const fromLaptop = op === "sync" || op === "commit";

  // An empty key must never match an empty header.
  const expected = fromLaptop ? relayKey : deskKey;
  if (!expected) return fail(res, 503, "relay not configured — set CALL_RELAY_KEY");
  const offered = String(req.headers[fromLaptop ? "x-relay-key" : "x-desk-key"] || "");
  if (!sameSecret(offered, expected)) return fail(res, 401, "bad key");

  const store = kv();
  if (!store) return fail(res, 503, "no store — add Redis to the Vercel project");

  const wants = { sync: "POST", commit: "POST", text: "POST", meta: "GET", part: "GET" }[op];
  if (!wants) return fail(res, 404, "no such op");
  if (req.method !== wants) {
    res.setHeader("Allow", wants);
    return fail(res, 405, "method not allowed");
  }

  if (op === "sync") return sync(req, res, store);
  if (op === "commit") return commit(req, res, store);
  if (op === "meta") return overview(req, res, store);
  if (op === "part") return part(req, res, store, url);
  return textMe(req, res, store);
}
