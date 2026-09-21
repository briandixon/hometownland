/**
 * /api/track — first-party traffic measurement for gohometownland.com.
 *
 * Two halves of one file, the way /api/call-relay is:
 *
 *   POST /api/track                 a page beacons in "somebody is reading me"
 *   GET  /api/track?key=SECRET      the /stats dashboard asks for the numbers
 *
 * What is stored is counters, and only counters. Every hit adds 1 to a handful
 * of fields in a per-day hash -- views, the path, and for the first page of a
 * visit the country, region, city, device and where the visitor came from.
 * There is no row per visitor, no IP address, no cookie and no identifier that
 * outlives the browser tab, so there is nothing here that can be turned back
 * into a person, and nothing that grows with traffic except the numbers.
 *
 * Geography comes from Vercel's own edge headers (x-vercel-ip-country and
 * friends), which are derived from the IP address before the request reaches
 * this function. We read the city, we never read or keep the address itself.
 *
 * Environment variables (Vercel > Project > Settings > Environment Variables):
 *   TRAFFIC_KEY    Required for GET. The password for /stats. Without it the
 *                  dashboard is off; recording still works.
 *
 * Storage is the same Redis the Call Desk uses, and the same variable names
 * are accepted, so a project already set up for the desk needs nothing added:
 *
 *   KV_REST_API_URL        + KV_REST_API_TOKEN          (Vercel KV, HTTPS)
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN   (Upstash, HTTPS)
 *   REDIS_URL / KV_URL                                  (any Redis, TCP)
 *
 * With no store configured nothing is recorded -- there is nowhere to put it,
 * and an in-memory count on one of many function instances would be a lie
 * rather than a shortfall. GET says so plainly, so the dashboard can report
 * "not connected" instead of "no visitors".
 */

import net from "node:net";
import tls from "node:tls";

const SITE_HOST = "gohometownland.com";
const PREFIX = "htl:d:";           // one hash per day: htl:d:2026-09-21
const RETENTION_DAYS = 400;        // a full year plus change, then it expires
const MAX_DAYS = 120;              // most the dashboard may ask for at once
const TOP_N = 15;                  // rows per table in the report

// Counters are grouped inside the day hash by a one-letter prefix.
const F = {
  views: "views",
  visits: "visits",
  leads: "leads",
  path: "p|",
  source: "s|",
  country: "c|",
  region: "r|",
  city: "y|",
  device: "v|",
  campaign: "k|",
};

const BOT = new RegExp([
  "bot", "crawl", "spider", "slurp", "search", "fetch", "monitor", "uptime",
  "pingdom", "lighthouse", "headless", "phantom", "curl", "wget", "python",
  "java/", "okhttp", "axios", "scrape", "preview", "facebookexternalhit",
  "semrush", "ahrefs", "mj12", "dotbot", "petal", "bytespider", "gptbot",
  "claudebot", "ccbot", "perplexity", "applebot",
].join("|"), "i");

// Referrer hosts worth showing under a name a human recognises. Anything not
// listed keeps its bare hostname, which is usually self-explanatory.
const NAMED = [
  [/^(www\.)?google\./, "Google"],
  [/^(www\.)?bing\./, "Bing"],
  [/duckduckgo\./, "DuckDuckGo"],
  [/search\.yahoo\./, "Yahoo"],
  [/ecosia\.org$/, "Ecosia"],
  [/facebook\.|fb\.me$/, "Facebook"],
  [/instagram\./, "Instagram"],
  [/(^|\.)t\.co$|twitter\.|(^|\.)x\.com$/, "X (Twitter)"],
  [/linkedin\.|lnkd\.in$/, "LinkedIn"],
  [/youtube\.|youtu\.be$/, "YouTube"],
  [/reddit\./, "Reddit"],
  [/pinterest\./, "Pinterest"],
  [/nextdoor\./, "Nextdoor"],
  [/craigslist\./, "Craigslist"],
  [/landwatch\./, "LandWatch"],
  [/land\.com$/, "Land.com"],
  [/zillow\./, "Zillow"],
  [/mail\.google\.|gmail\./, "Gmail"],
  [/outlook\.|live\.com$|office\.com$/, "Outlook"],
  [/chatgpt\.com$|openai\.com$/, "ChatGPT"],
  [/claude\.ai$/, "Claude"],
  [/perplexity\.ai$/, "Perplexity"],
];

/* ------------------------------------------------------------------ store */

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

function kv() {
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

/**
 * Read one RESP value starting at `i`, returning it with the offset after it.
 * Arrays nest, because HGETALL answers with one -- which is the difference
 * between this parser and the simpler one in call-relay.js.
 */
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
    return { value: buf.slice(start, start + len).toString(), next: start + len + 2 };
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
 * A serverless invocation is short-lived, so there is nothing to gain from
 * keeping the connection: AUTH, every command and QUIT go out in a single
 * write, and the server hanging up is the signal to parse. Failure resolves
 * null rather than throwing -- a missed page view is not worth an error page.
 */
function wireBatch(store, commands) {
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

    socket.setTimeout(5000, () => finish(null));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", () => finish(null));
    socket.on("end", () => {
      const replies = parseReplies(Buffer.concat(chunks));
      finish(replies.slice(store.password ? 1 : 0));
    });
  });
}

/** Run a batch of commands against whichever store is configured. */
async function batch(store, commands) {
  if (!store || !commands.length) return null;

  if (store.kind === "wire") return wireBatch(store, commands);

  try {
    const res = await fetch(`${store.url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${store.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands.map((c) => c.map(String))),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!Array.isArray(body)) return null;
    return body.map((r) => (r && "result" in r ? r.result : null));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- the writing */

/**
 * The day a hit belongs to, in the owner's timezone rather than UTC.
 * en-CA formats as YYYY-MM-DD, which sorts and reads the same way.
 */
function dayKey(date) {
  return date.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function daysBack(n) {
  const out = [];
  const now = Date.now();
  for (let i = 0; i < n; i++) out.push(dayKey(new Date(now - i * 86400000)));
  return out.reverse();
}

/** Trim a label to something safe to use as a hash field. */
function label(raw, max) {
  return String(raw || "")
    .replace(/[\r\n\t|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * A page path we are willing to count.
 *
 * The path arrives from the browser, so it is not trusted: query strings and
 * fragments go, the character set is narrowed, and only the first two segments
 * survive. That last part matters -- it is what stops a script inventing a
 * million distinct URLs and turning one day's hash into a million fields.
 */
function cleanPath(raw) {
  let p = String(raw || "/").split("?")[0].split("#")[0].toLowerCase();
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/[^a-z0-9/._-]/g, "").replace(/\/{2,}/g, "/").replace(/\.html$/, "");
  const segments = p.split("/").filter(Boolean).slice(0, 2);
  return segments.length ? `/${segments.join("/")}`.slice(0, 60) : "/";
}

/** Where this visit came from: an explicit campaign tag, else the referrer. */
function sourceOf(referrer, utm, host) {
  if (utm) return label(utm, 40);

  let u;
  try {
    u = new URL(referrer);
  } catch {
    return "Direct / typed in";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "Direct / typed in";

  const from = u.hostname.toLowerCase();
  // Our own pages are not a source. Only the first page of a visit records one
  // at all, so this is a visitor whose session marker we could not read.
  if (host && from.replace(/^www\./, "") === String(host).toLowerCase().replace(/^www\./, "")) {
    return "Direct / typed in";
  }
  for (const [pattern, name] of NAMED) if (pattern.test(from)) return name;
  return label(from.replace(/^www\./, ""), 40);
}

function deviceOf(ua) {
  if (/ipad|tablet|playbook|silk|kindle/i.test(ua)) return "Tablet";
  if (/mobi|android|iphone|ipod|phone/i.test(ua)) return "Phone";
  return "Desktop";
}

/** Vercel RFC3986-encodes city names, so "Winston%2DSalem" has to be decoded. */
function header(req, name) {
  const v = req.headers[name];
  if (!v) return "";
  try {
    return decodeURIComponent(String(v));
  } catch {
    return String(v);
  }
}

async function record(req, res) {
  // A beacon is fire-and-forget: it never learns whether anything was stored,
  // and it never gets an error back to log in somebody's console.
  const done = () => res.status(204).end();

  const ua = String(req.headers["user-agent"] || "");
  if (!ua || BOT.test(ua)) return done();

  // Every branch gets its own preview URL on Vercel, and every preview shares
  // this Redis. Counting them would mix work-in-progress hits into the real
  // numbers, so only the live domain is recorded.
  const host = String(req.headers.host || "").toLowerCase().split(":")[0];
  if (host !== SITE_HOST && !host.endsWith(`.${SITE_HOST}`)) return done();

  const store = kv();
  if (!store) {
    console.warn("[track] no store configured — nothing recorded");
    return done();
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body && typeof body === "object" ? body : {};

  const key = PREFIX + dayKey(new Date());
  const bump = (field, by = 1) => ["HINCRBY", key, field, String(by)];
  const commands = [];

  if (body.e) {
    // A named event rather than a page view. Only the one we send today.
    if (label(body.e, 20) !== "lead") return done();
    commands.push(bump(F.leads));
  } else {
    const first = body.n === 1 || body.n === "1";
    commands.push(bump(F.views));
    commands.push(bump(F.path + cleanPath(body.p)));

    if (first) {
      const country = label(header(req, "x-vercel-ip-country"), 2).toUpperCase();
      const region = label(header(req, "x-vercel-ip-country-region"), 3).toUpperCase();
      const city = label(header(req, "x-vercel-ip-city"), 40);
      const campaign = label(body.c, 40);

      commands.push(bump(F.visits));
      commands.push(bump(F.source + sourceOf(body.r, body.s, req.headers.host)));
      commands.push(bump(F.device + deviceOf(ua)));
      if (country) commands.push(bump(F.country + country));
      if (country && region) commands.push(bump(F.region + `${country}-${region}`));
      if (city) {
        commands.push(bump(F.city + [city, region, country].filter(Boolean).join(", ")));
      }
      if (campaign) commands.push(bump(F.campaign + campaign));
    }
  }

  // Keep a year and change, then let the day fall off on its own. EXPIRE is
  // idempotent, so re-setting it on every hit costs one command and removes
  // any need to know whether the key is new.
  commands.push(["EXPIRE", key, String(RETENTION_DAYS * 86400)]);

  await batch(store, commands);
  return done();
}

/* ------------------------------------------------------------- the reading */

/** Timing-safe string compare, so the key cannot be guessed a character at a time. */
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** HGETALL comes back as a flat array over a socket and an object over HTTPS. */
function toMap(reply) {
  const out = {};
  if (!reply) return out;
  if (Array.isArray(reply)) {
    for (let i = 0; i < reply.length - 1; i += 2) out[reply[i]] = Number(reply[i + 1]) || 0;
  } else if (typeof reply === "object") {
    for (const [k, v] of Object.entries(reply)) out[k] = Number(v) || 0;
  }
  return out;
}

/** Pull one prefixed group out of a day's hash and add it into a running tally. */
function collect(into, day, prefix) {
  for (const [field, count] of Object.entries(day)) {
    if (field.startsWith(prefix)) {
      const name = field.slice(prefix.length);
      into[name] = (into[name] || 0) + count;
    }
  }
}

function ranked(tally) {
  return Object.entries(tally)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_N)
    .map(([name, count]) => ({ name, count }));
}

async function report(req, res) {
  const secret = process.env.TRAFFIC_KEY;
  if (!secret) {
    return res.status(503).json({ ok: false, error: "TRAFFIC_KEY is not set on this project" });
  }

  const url = new URL(req.url, `https://${req.headers.host}`);
  const offered = url.searchParams.get("key") || req.headers["x-traffic-key"] || "";
  if (!sameSecret(String(offered), secret)) {
    return res.status(401).json({ ok: false, error: "bad key" });
  }

  const store = kv();
  if (!store) {
    return res.status(200).json({
      ok: true,
      store: "none",
      note: "No Redis store is connected, so nothing is being recorded. "
          + "Add one from Vercel > Storage and redeploy.",
    });
  }

  const asked = Number(url.searchParams.get("days"));
  const days = Math.min(Math.max(Number.isFinite(asked) ? asked : 30, 1), MAX_DAYS);
  const dates = daysBack(days);

  const replies = await batch(store, dates.map((d) => ["HGETALL", PREFIX + d]));
  if (!replies) {
    return res.status(502).json({ ok: false, error: "the store did not answer" });
  }

  const totals = { views: 0, visits: 0, leads: 0 };
  const groups = { pages: {}, sources: {}, countries: {}, regions: {}, cities: {}, devices: {}, campaigns: {} };
  const daily = [];

  dates.forEach((date, i) => {
    const day = toMap(replies[i]);
    const views = day[F.views] || 0;
    const visits = day[F.visits] || 0;
    const leads = day[F.leads] || 0;
    totals.views += views;
    totals.visits += visits;
    totals.leads += leads;
    daily.push({ date, views, visits, leads });

    collect(groups.pages, day, F.path);
    collect(groups.sources, day, F.source);
    collect(groups.countries, day, F.country);
    collect(groups.regions, day, F.region);
    collect(groups.cities, day, F.city);
    collect(groups.devices, day, F.device);
    collect(groups.campaigns, day, F.campaign);
  });

  return res.status(200).json({
    ok: true,
    store: store.name,
    days,
    from: dates[0],
    to: dates[dates.length - 1],
    totals,
    daily,
    pages: ranked(groups.pages),
    sources: ranked(groups.sources),
    countries: ranked(groups.countries),
    regions: ranked(groups.regions),
    cities: ranked(groups.cities),
    devices: ranked(groups.devices),
    campaigns: ranked(groups.campaigns),
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "POST") return record(req, res);
  if (req.method === "GET") return report(req, res);

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
