/**
 * The cloud copy of the Call Desk: mailer records on the site, so a caller can
 * be looked up -- and texted to your cell -- with the laptop shut.
 *
 * Not a route (leading underscore). Used by /api/desk, which the phone page
 * and the laptop's sync talk to, and by /api/call-relay, which texts you when
 * a call rings.
 *
 * How the records are kept. The laptop sends every record in numbered
 * batches under a new "generation", then commits it; the commit is what makes
 * that copy the live one and deletes the copy before it. A sync that dies
 * halfway never replaces a good copy -- its batches expire on their own.
 *
 *   desk:meta                  JSON: { gen, records, files, at }  -- the live copy
 *   desk:g:<gen>:lead          hash: record number -> record JSON
 *   desk:g:<gen>:phone         hash: ten-digit number -> record number
 *   desk:recent                list: the last 30 calls the relay saw
 *   desk:seen:<callId>         set once per call, so a webhook Quo retries
 *                              does not text you twice
 *
 * Texting uses Quo's own API, from your Quo line to your cell:
 *
 *   QUO_API_KEY      Required for texts. Quo > Settings > API.
 *   CALL_TEXT_TO     Required for texts. Your cell, e.g. 2695551234.
 *   CALL_TEXT_FROM   Optional. The Quo line to send from: its PN... id or its
 *                    number. Default the first QUO_INBOX_ID, else PNu6laiBJX.
 *   CALL_TEXT        Optional. "all" (default) texts every call, matched or
 *                    not; "matched" only callers found in the mailers; "off".
 */

import { batch } from "./_store.js";

export const META_KEY = "desk:meta";
export const RECENT_KEY = "desk:recent";
export const RINGING_KEY = "calldesk:ringing";   // written by call-relay.js
export const RECENT_MAX = 30;
export const PART_SIZE = 200;                    // records per sync batch / page fetch
export const STAGING_TTL = 6 * 3600;             // an uncommitted sync lasts this long

export const leadKey = (gen) => `desk:g:${gen}:lead`;
export const phoneKey = (gen) => `desk:g:${gen}:phone`;

export const GEN_RE = /^[0-9a-z-]{6,40}$/;

const QUO_MESSAGES = "https://api.openphone.com/v1/messages";
const TEXT_MAX = 1600;                           // Quo's limit for one message

/** Ten digits, the form the mailer files are indexed by. */
export function tenDigits(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length === 10 ? d : "";
}

export function parseJSON(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function readMeta(store) {
  const r = await batch(store, [["GET", META_KEY]]);
  return r ? parseJSON(r[0]) : null;
}

/** The record a caller's number belongs to in the live copy, or null. */
export async function leadByPhone(store, number) {
  const digits = tenDigits(number);
  if (!digits) return null;
  const meta = await readMeta(store);
  if (!meta || !meta.gen) return null;
  const r = await batch(store, [["HGET", phoneKey(meta.gen), digits]]);
  const index = r && r[0];
  if (index == null) return null;
  return leadByIndex(store, meta.gen, index);
}

export async function leadByIndex(store, gen, index) {
  const r = await batch(store, [["HGET", leadKey(gen), String(index)]]);
  const lead = r ? parseJSON(r[0]) : null;
  return lead ? { lead, index: Number(index) } : null;
}

/* ------------------------------------------------------------ the text */

function fmtPhone(d) {
  const t = tenDigits(d);
  return t ? `(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}` : String(d || "");
}

function usd(n) {
  if (n == null || n === "" || !Number.isFinite(Number(n))) return "";
  return "$" + Math.round(Number(n)).toLocaleString("en-US");
}

function num(n) {
  return n == null || n === "" || !Number.isFinite(Number(n)) ? null : Number(n);
}

function pct(a, b) {
  return num(a) != null && num(b) ? `${Math.round((a / b) * 100)}%` : "";
}

/**
 * The market value and market $/acre the card shows, from whichever columns
 * the campaign file carried. Retail Value is market value; a slimmer export
 * that only has the market $/acre gets it multiplied out.
 */
export function marketOf(lead) {
  const acres = num(lead.calcAcres) || num(lead.acres);
  const ppa = num(lead.realPPA) || (num(lead.retailFull) && acres ? lead.retailFull / acres : null);
  const value = num(lead.retailFull) || (ppa && acres ? ppa * acres : null);
  return { value, ppa, acres };
}

/**
 * Everything worth glancing at mid-call, as one plain-ASCII text.
 *
 * ASCII on purpose: a single curly quote or em dash switches the whole
 * message to the 70-character encoding and roughly doubles what it costs.
 */
export function composeText(lead, { caller = "", origin = "", dialed = "" } = {}) {
  const L = [];
  const phones = Array.isArray(lead.phones) ? lead.phones : [];
  const line = caller ? phones.find((p) => p.num === tenDigits(caller)) : null;
  const { value, ppa, acres } = marketOf(lead);
  const parcel = lead.parcel || {};

  L.push(caller
    ? `CALL ${fmtPhone(caller)}` + (line ? ` (${[line.label, line.type].filter(Boolean).join(", ")})` : "")
    : "CARD");
  if (caller && dialed) L.push(`To your ${dialed.slice(0, 3)} line`);
  if (line && line.dnc) L.push("This number is flagged DNC - they called you");
  L.push(`Ref ${lead.ref || "-"}` + (lead.mailer ? `  Mailer #${lead.mailer}` : ""));
  if (lead.owner) L.push(`Owner: ${lead.owner}`);
  if (lead.greet && lead.greet !== lead.owner) L.push(`Ask for: ${lead.greet}`);
  L.push("");

  if (num(lead.offer) != null) {
    const bits = [lead.offerPPA ? `${usd(lead.offerPPA)}/ac` : "",
      lead.ppaPct ? `${Math.round(lead.ppaPct * 100)}% of mkt` : ""].filter(Boolean);
    L.push(`Offer: ${usd(lead.offer)}` + (bits.length ? ` (${bits.join(", ")})` : ""));
  }
  if (value || ppa) {
    L.push(`Market: ${value ? usd(value) : "-"}` + (ppa ? ` (${usd(ppa)}/ac)` : ""));
  }
  if (num(lead.retail)) L.push(`Retail 90%: ${usd(lead.retail)}`);
  if (num(lead.tlp)) {
    L.push(`TLP est: ${usd(lead.tlp)}` + (num(lead.offer) ? ` (offer is ${pct(lead.offer, lead.tlp)})` : ""));
  }
  if (num(lead.profit)) L.push(`Profit: ${usd(lead.profit)}`);
  if (acres) L.push(`Acres: ${acres}`);
  L.push("");

  const cityLine = [lead.pCity, [lead.pState, lead.pZip].filter(Boolean).join(" ")]
    .filter(Boolean).join(", ");
  if (lead.pAddr || cityLine) L.push(`Parcel: ${[lead.pAddr, cityLine].filter(Boolean).join(", ")}`);
  if (lead.pCounty) L.push(`County: ${lead.pCounty}${lead.pState ? ", " + lead.pState : ""}`);
  if (lead.muni) L.push(`Township: ${lead.muni}`);
  if (lead.apn) L.push(`APN: ${lead.apn}`);

  const land = [
    lead.zoning ? `Zoning ${lead.zoning === "CALL" ? "- call the township" : lead.zoning}` : "",
    lead.use ? `Use ${lead.use}` : "",
    num(lead.roadFt) != null ? `Road ${Math.round(lead.roadFt)} ft` : "",
  ].filter(Boolean);
  if (land.length) L.push(land.join(" | "));

  const terrain = [
    num(lead.build) != null ? `Buildable ${lead.build.toFixed(0)}%` : "",
    num(lead.flood) != null ? `Flood ${lead.flood.toFixed(0)}%` : "",
    num(lead.wetlands) != null ? `Wetlands ${lead.wetlands.toFixed(0)}%` : "",
    num(lead.slope) != null ? `Slope ${lead.slope.toFixed(1)}%` : "",
  ].filter(Boolean);
  if (terrain.length) L.push(terrain.join(" | "));
  if (parcel.land_locked) L.push("LAND LOCKED (Land Portal)");
  if (parcel.flood_zone) L.push(`Flood zone: ${parcel.flood_zone}`);
  if (num(parcel.tax_amount) != null) L.push(`Tax/yr: ${usd(parcel.tax_amount)}`);

  const dates = [lead.offerDate ? `Mailed ${lead.offerDate}` : "",
    lead.closeDate ? `Close by ${lead.closeDate}` : ""].filter(Boolean);
  if (dates.length) L.push(dates.join(" | "));
  if (lead.mCity && lead.pCity && lead.mCity.toLowerCase() !== lead.pCity.toLowerCase()) {
    L.push(`Owner lives in: ${[lead.mCity, lead.mState].filter(Boolean).join(", ")} (absentee)`);
  }
  L.push("");

  if (lead.link) L.push(`Land Portal: ${lead.link}`);
  if (origin && lead.ref) L.push(`Card: ${origin}/desk#r=${encodeURIComponent(lead.ref)}`);

  return ascii(L.join("\n").replace(/\n{3,}/g, "\n\n").trim()).slice(0, TEXT_MAX);
}

export function composeUnmatched(caller, origin, dialed = "") {
  return ascii([
    `CALL ${fmtPhone(caller)} - no mailer match.`,
    dialed ? `To your ${dialed.slice(0, 3)} line` : "",
    "Ask for the reference on their letter.",
    origin ? `Look up: ${origin}/desk` : "",
  ].filter(Boolean).join("\n"));
}

function ascii(s) {
  return String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .normalize("NFKD")
    .replace(/[^\x20-\x7e\n]/g, "");
}

export function textingReady() {
  return Boolean(process.env.QUO_API_KEY && tenDigits(process.env.CALL_TEXT_TO));
}

/**
 * Send one text to your cell through Quo. Never throws.
 *
 * Marked done in Quo as it is sent, so the texts you send yourself do not
 * pile up as open conversations in the inbox you work sellers from.
 */
export async function sendText(content) {
  const key = process.env.QUO_API_KEY;
  const to = tenDigits(process.env.CALL_TEXT_TO);
  if (!key || !to) return { sent: false, error: "texting not configured" };
  // QUO_INBOX_ID may list several lines; a text goes from the first.
  const from = process.env.CALL_TEXT_FROM
    || String(process.env.QUO_INBOX_ID || "").split(/[\s,]+/).filter(Boolean)[0]
    || "PNu6laiBJX";

  try {
    const res = await fetch(QUO_MESSAGES, {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({
        content, from: /^\d/.test(from) ? `+1${tenDigits(from)}` : from,
        to: [`+1${to}`], setInboxStatus: "done",
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { sent: true };
    let why = "";
    try {
      const body = await res.json();
      why = body.message || body.error || "";
    } catch {
      /* not JSON */
    }
    return { sent: false, error: `Quo said ${res.status}${why ? ": " + why : ""}` };
  } catch (err) {
    return { sent: false, error: `could not reach Quo (${err.name || err})` };
  }
}

/**
 * Everything the relay does once a call is ringing: remember it for the phone
 * page, look the caller up in the cloud copy, and text you the card.
 *
 * Runs before the relay answers Quo, because a serverless function stops once
 * it has replied. Every step swallows its own failure: nothing here may stop
 * the relay telling Quo it got the call.
 */
export async function afterRing(store, call, origin) {
  const mode = String(process.env.CALL_TEXT || "all").toLowerCase();
  const result = { matched: false, texted: false };

  if (store) {
    // Quo retries a webhook it thinks failed. The first delivery wins.
    const seen = await batch(store, [
      ["SET", `desk:seen:${call.callId || call.caller + call.at}`, "1", "NX", "EX", "900"],
    ]);
    if (seen && seen[0] !== "OK") return { ...result, duplicate: true };
  }

  const hit = store ? await leadByPhone(store, call.caller) : null;
  result.matched = Boolean(hit);
  if (hit) result.ref = hit.lead.ref || "";

  if (store) {
    await batch(store, [
      ["LPUSH", RECENT_KEY, JSON.stringify({
        at: call.at, caller: call.caller, line: call.line || "", ref: hit ? hit.lead.ref || "" : "",
        name: hit ? hit.lead.greet || hit.lead.owner || "" : "",
      })],
      ["LTRIM", RECENT_KEY, "0", String(RECENT_MAX - 1)],
    ]);
  }

  if (mode === "off" || !textingReady()) return result;
  if (!hit && mode === "matched") return result;

  const content = hit
    ? composeText(hit.lead, { caller: call.caller, origin, dialed: call.line })
    : composeUnmatched(call.caller, origin, call.line);
  const sent = await sendText(content);
  result.texted = sent.sent;
  if (!sent.sent) result.textError = sent.error;
  return result;
}
