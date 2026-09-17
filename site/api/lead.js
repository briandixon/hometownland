/**
 * POST /api/lead — receives an offer request and files it in the CRM.
 *
 * Runs server-side on Vercel so the Airtable token is never exposed to the
 * browser. Two things happen, independently of each other:
 *
 *   1. Airtable — a Contacts record (reused if we already know the email) and
 *      a Leads record linked to it, in the same base the sales team works in.
 *   2. Email — a notification, either from the Airtable automation that
 *      watches Source = Website, or from Resend if it is configured here.
 *
 * Neither is required for the request to succeed, and the full submission is
 * logged when nothing is configured, so a lead is never lost to a missing
 * environment variable.
 *
 * Environment variables (Vercel > Project > Settings > Environment Variables):
 *   AIRTABLE_TOKEN           Personal access token with data.records:read and
 *                            data.records:write, granted on the CRM base
 *   AIRTABLE_BASE_ID         Optional; defaults to the CRM base below
 *   AIRTABLE_TABLE           Optional; defaults to "Leads"
 *   AIRTABLE_CONTACTS_TABLE  Optional; defaults to "Contacts"
 *   RESEND_API_KEY           Optional; enables the email notification from here
 *   NOTIFY_EMAIL             Where notifications go
 *   NOTIFY_FROM              Verified sender, e.g. "Hometown Land <site@gohometownland.com>"
 */

// The CRM base. Not a secret — it is in the Airtable URL — and only useful to
// somebody holding the token, which is never in this repository.
const DEFAULT_BASE_ID = "appdd0mQPJU7ZPAtw";
const DEFAULT_LEADS_TABLE = "Leads";
const DEFAULT_CONTACTS_TABLE = "Contacts";

/**
 * Field names as they exist in the CRM today. scripts/setup-airtable.py checks
 * the live base against this list, so a rename shows up there rather than as a
 * dropped lead. The trailing space in "Email " is real, not a typo.
 */
const LEAD = {
  callerName: "Caller Name",
  phone: "Phone",
  acres: "Acres",
  salesStage: "Sales Stage",
  interested: "Are you interested in selling your land? ",
  notes: "Deal/Property Notes",
  contact: "Contact",
  reference: "Reference Number",
  source: "Source",
  state: "Property State",
  county: "Property County",
  parcel: "Parcel / APN",
  ownership: "Ownership",
  access: "Road Access",
  timeline: "Timeline",
  bestTime: "Best Time",
  smsConsent: "SMS Consent",
  smsConsentAt: "SMS Consent At",
};

const CONTACT = {
  first: "First Name",
  last: "Last name",
  email: "Email ",
  phone: "Phone Number",
  type: "Contact Type",
};

const FIELDS = [
  "state", "county", "parcel", "acres",
  "ownership", "access", "timeline", "notes",
  "name", "email", "phone", "besttime", "smsConsent", "pageUrl",
];

function clean(body) {
  const out = {};
  for (const key of FIELDS) {
    const v = body[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim().slice(0, 2000);
  }
  return out;
}

function validate(d) {
  const problems = [];
  if (!d.state) problems.push("state");
  if (!d.county) problems.push("county");
  if (!d.name) problems.push("name");
  if (!d.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) problems.push("email");
  return problems;
}

/** "Jane Van Doe" -> { first: "Jane", last: "Van Doe" } */
function splitName(name) {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { first: name, last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

function eastern(date) {
  return date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  }) + " ET";
}

/** What the sales team reads first: the seller's own words, then provenance. */
function leadNotes(d, now) {
  const lines = [];
  if (d.notes) lines.push(d.notes, "");
  lines.push(`Website offer request — gohometownland.com${d.pageUrl ? ` (${d.pageUrl})` : ""}`);
  lines.push(`Submitted ${eastern(now)}`);
  // Every other answer has its own field; the email only reaches this record
  // through the Contact link, so keep a copy here in case that link is missing.
  lines.push(`Email: ${d.email}`);
  return lines.join("\n");
}

async function airtable(path, { token, method = "GET", body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://api.airtable.com/v0/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reuse the Contacts record for this email if the CRM already has one, so a
 * seller who submits twice does not become two contacts. Returns a record id,
 * or null if the lookup and the create both fail — the lead still gets filed.
 */
async function findOrCreateContact(d, { token, baseId, table }) {
  const quoted = `"${d.email.toLowerCase().replace(/["\\]/g, "\\$&")}"`;
  const query = new URLSearchParams({
    filterByFormula: `LOWER({${CONTACT.email}})=${quoted}`,
    maxRecords: "1",
  });
  query.append("fields[]", CONTACT.email);

  const found = await airtable(
    `${baseId}/${encodeURIComponent(table)}?${query}`, { token }
  );
  if (found.records && found.records.length) return found.records[0].id;

  const { first, last } = splitName(d.name);
  const fields = {
    [CONTACT.first]: first,
    [CONTACT.email]: d.email,
    [CONTACT.type]: "Seller",
  };
  if (last) fields[CONTACT.last] = last;
  if (d.phone) fields[CONTACT.phone] = d.phone;

  const created = await airtable(`${baseId}/${encodeURIComponent(table)}`, {
    token, method: "POST", body: { records: [{ fields }], typecast: true },
  });
  return created.records[0].id;
}

/**
 * File the submission in the CRM: a Leads record, linked to its contact.
 * Returns { status, recordId, contact } — status "skipped" when Airtable is
 * not configured yet.
 */
async function toAirtable(d) {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) return { status: "skipped" };

  const baseId = process.env.AIRTABLE_BASE_ID || DEFAULT_BASE_ID;
  const leadsTable = process.env.AIRTABLE_TABLE || DEFAULT_LEADS_TABLE;
  const contactsTable = process.env.AIRTABLE_CONTACTS_TABLE || DEFAULT_CONTACTS_TABLE;
  const now = new Date();

  // A contact we cannot create is worth losing; the lead behind it is not.
  let contactId = null;
  let contact = "ok";
  try {
    contactId = await findOrCreateContact(d, { token, baseId, table: contactsTable });
  } catch (err) {
    contact = "error";
    console.error("[lead] contact lookup/create failed:", err.message);
  }

  const acres = d.acres ? Number(String(d.acres).replace(/[^0-9.]/g, "")) : undefined;
  const fields = {
    [LEAD.callerName]: d.name,
    [LEAD.source]: "Website",
    [LEAD.salesStage]: "1.0 New Lead",
    // They filled in a form asking us to buy their land.
    [LEAD.interested]: "Yes",
    [LEAD.reference]: "WEB",
    [LEAD.state]: d.state,
    [LEAD.county]: d.county,
    [LEAD.notes]: leadNotes(d, now),
    // SMS opt-in record for A2P 10DLC / TCPA compliance.
    [LEAD.smsConsent]: d.smsConsent === "yes" ? "Yes" : "No",
  };
  if (d.phone) fields[LEAD.phone] = d.phone;
  if (d.parcel) fields[LEAD.parcel] = d.parcel;
  if (d.ownership) fields[LEAD.ownership] = d.ownership;
  if (d.access) fields[LEAD.access] = d.access;
  if (d.timeline) fields[LEAD.timeline] = d.timeline;
  if (d.besttime) fields[LEAD.bestTime] = d.besttime;
  if (Number.isFinite(acres)) fields[LEAD.acres] = acres;
  if (d.smsConsent === "yes") fields[LEAD.smsConsentAt] = now.toISOString();
  if (contactId) fields[LEAD.contact] = [contactId];

  const res = await airtable(`${baseId}/${encodeURIComponent(leadsTable)}`, {
    token,
    method: "POST",
    // typecast lets Airtable coerce plain strings into single-select options
    body: { records: [{ fields }], typecast: true },
  });

  const recordId = res.records[0].id;
  console.log(`[lead] filed ${recordId} (contact ${contact})`);
  return { status: "ok", recordId, contact, baseId, leadsTable };
}

/**
 * Optional second notification path. The Airtable automation on Source =
 * Website already emails on every new lead; this exists for the case where the
 * Airtable write is the thing that failed, and for anyone who would rather the
 * site sent the mail itself. Leave RESEND_API_KEY unset to use only Airtable.
 */
async function notify(d, filed) {
  const { RESEND_API_KEY, NOTIFY_EMAIL, NOTIFY_FROM } = process.env;
  if (!RESEND_API_KEY || !NOTIFY_EMAIL || !NOTIFY_FROM) return "skipped";

  const rows = [
    ["Name", d.name], ["Email", d.email], ["Phone", d.phone],
    ["Best time", d.besttime], ["State", d.state], ["County", d.county],
    ["Parcel / APN", d.parcel], ["Acres", d.acres], ["Ownership", d.ownership],
    ["Road access", d.access], ["Timeline", d.timeline], ["Notes", d.notes],
    ["SMS consent", d.smsConsent === "yes" ? "Yes — agreed to receive texts" : "No"],
  ].filter(([, v]) => v);

  const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const link = filed && filed.recordId
    ? `https://airtable.com/${filed.baseId}/${encodeURIComponent(filed.leadsTable)}/${filed.recordId}`
    : null;

  const html =
    `<h2 style="font-family:Georgia,serif;color:#22394A">New property submission</h2>` +
    `<table cellpadding="6" style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse">` +
    rows.map(([k, v]) =>
      `<tr><td style="color:#77848D;border-bottom:1px solid #DCE3E8">${esc(k)}</td>` +
      `<td style="border-bottom:1px solid #DCE3E8"><strong>${esc(v)}</strong></td></tr>`).join("") +
    `</table>` +
    (link
      ? `<p style="font-family:Arial,sans-serif;font-size:14px"><a href="${link}">Open this lead in the CRM</a></p>`
      : `<p style="font-family:Arial,sans-serif;font-size:14px;color:#A2543C">` +
        `<strong>This one did not reach Airtable.</strong> File it by hand.</p>`);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: NOTIFY_FROM,
      to: [NOTIFY_EMAIL],
      reply_to: d.email,
      subject: `New land submission — ${d.county}, ${d.state}`,
      html,
    }),
  });

  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return "ok";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // honeypot: a real person never sees this field
  if (body.company) return res.status(200).json({ ok: true });

  const data = clean(body);
  const problems = validate(data);
  if (problems.length) {
    return res.status(400).json({ error: "Missing or invalid fields", fields: problems });
  }

  const results = {};
  let filed = null;

  try {
    filed = await toAirtable(data);
    results.airtable = filed.status;
  } catch (err) {
    results.airtable = "error";
    console.error("[lead] airtable failed:", err.message);
  }

  // The email goes out whatever Airtable did — most of all when Airtable
  // failed, since then it is the only copy of the submission.
  try {
    results.email = await notify(data, filed);
  } catch (err) {
    results.email = "error";
    console.error("[lead] email failed:", err.message);
  }

  // Nothing configured yet: log it so the submission is at least recoverable
  // from the Vercel function logs rather than silently dropped.
  if (results.airtable === "skipped" && results.email === "skipped") {
    console.log("[lead] no destination configured, submission:", JSON.stringify(data));
  }

  // A destination erroring is our problem, not the seller's — but we should not
  // claim success, or the lead disappears with nobody aware of it.
  if (results.airtable !== "ok" && results.email !== "ok") {
    if (results.airtable === "error" || results.email === "error") {
      console.error("[lead] nowhere to file, submission:", JSON.stringify(data));
      return res.status(502).json({ error: "Could not file submission" });
    }
  }

  return res.status(200).json({ ok: true });
}
