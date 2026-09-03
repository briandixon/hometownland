/**
 * POST /api/lead — receives an offer request and files it.
 *
 * Runs server-side on Vercel so the Airtable token is never exposed to the
 * browser. Every integration is optional: whatever is configured runs, and the
 * submission is never lost just because one destination is not set up yet.
 *
 * Environment variables (Vercel > Project > Settings > Environment Variables):
 *   AIRTABLE_TOKEN    Personal access token with data.records:write
 *   AIRTABLE_BASE_ID  e.g. appXXXXXXXXXXXXXX
 *   AIRTABLE_TABLE    Table name, e.g. "Website Leads"
 *   RESEND_API_KEY    Optional; enables the email notification
 *   NOTIFY_EMAIL      Where notifications go
 *   NOTIFY_FROM       Verified sender, e.g. "Hometown Land <site@gohometownland.com>"
 */

const FIELDS = [
  "state", "county", "parcel", "acres",
  "ownership", "access", "timeline", "notes",
  "name", "email", "phone", "besttime", "smsConsent",
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

async function toAirtable(d) {
  const { AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE } = process.env;
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE) return "skipped";

  const acres = d.acres ? Number(String(d.acres).replace(/[^0-9.]/g, "")) : undefined;

  // Field names must match scripts/setup-airtable.py exactly.
  const fields = {
    "Name": d.name,
    "Email": d.email,
    "Phone": d.phone || "",
    "Best Time": d.besttime || "",
    "State": d.state,
    "County": d.county,
    "Parcel / APN": d.parcel || "",
    "Ownership": d.ownership || "",
    "Road Access": d.access || "",
    "Timeline": d.timeline || "",
    "Notes": d.notes || "",
    "Received": new Date().toISOString(),
    "Source": "Website",
    "Status": "New",
    // SMS opt-in record for A2P 10DLC / TCPA compliance.
    "SMS Consent": d.smsConsent === "yes" ? "Yes" : "No",
  };
  if (Number.isFinite(acres)) fields["Acres"] = acres;
  if (d.smsConsent === "yes") fields["SMS Consent At"] = new Date().toISOString();

  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        "Content-Type": "application/json",
      },
      // typecast lets Airtable coerce plain strings into single-select options
      body: JSON.stringify({ records: [{ fields }], typecast: true }),
    }
  );

  if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
  return "ok";
}

async function notify(d) {
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
  const html =
    `<h2 style="font-family:Georgia,serif;color:#22394A">New property submission</h2>` +
    `<table cellpadding="6" style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse">` +
    rows.map(([k, v]) =>
      `<tr><td style="color:#77848D;border-bottom:1px solid #DCE3E8">${esc(k)}</td>` +
      `<td style="border-bottom:1px solid #DCE3E8"><strong>${esc(v)}</strong></td></tr>`).join("") +
    `</table>`;

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
  let failed = false;

  for (const [label, fn] of [["airtable", toAirtable], ["email", notify]]) {
    try {
      results[label] = await fn(data);
    } catch (err) {
      failed = true;
      results[label] = "error";
      console.error(`[lead] ${label} failed:`, err.message);
    }
  }

  // Nothing configured yet: log it so the submission is at least recoverable
  // from the Vercel function logs rather than silently dropped.
  if (results.airtable === "skipped" && results.email === "skipped") {
    console.log("[lead] no destination configured, submission:", JSON.stringify(data));
  }

  // A destination erroring is our problem, not the seller's — but we should not
  // claim success, or the lead disappears with nobody aware of it.
  if (failed && results.airtable !== "ok" && results.email !== "ok") {
    return res.status(502).json({ error: "Could not file submission" });
  }

  return res.status(200).json({ ok: true });
}
