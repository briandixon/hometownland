"""Check (and if needed create) the CRM fields that /api/lead writes into.

The website form files straight into the sales CRM: a Contacts record plus a
Leads record linked to it. This script proves the base still looks the way
src/api/lead.js expects, and adds any Leads field that is missing. It never
edits or deletes a field that already exists, so it is safe to re-run.

    set AIRTABLE_TOKEN=pat...        (Windows CMD)
    $env:AIRTABLE_TOKEN="pat..."     (PowerShell)
    export AIRTABLE_TOKEN=pat...     (bash)

    python scripts/setup-airtable.py            # report only
    python scripts/setup-airtable.py --create   # also add missing Leads fields

The token needs schema.bases:read and, for --create, schema.bases:write, and
must be granted access to the base below.
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE_ID = os.environ.get("AIRTABLE_BASE_ID", "appdd0mQPJU7ZPAtw")
LEADS_TABLE = os.environ.get("AIRTABLE_TABLE", "Leads")
CONTACTS_TABLE = os.environ.get("AIRTABLE_CONTACTS_TABLE", "Contacts")
TOKEN = os.environ.get("AIRTABLE_TOKEN")


def sel(*names):
    return {"choices": [{"name": n} for n in names]}


# Fields /api/lead adds to the CRM's Leads table. Names must match the LEAD map
# in src/api/lead.js exactly.
LEAD_FIELDS = [
    {"name": "Source", "type": "singleSelect",
     "options": {"choices": [
         {"name": "Website", "color": "greenBright"},
         {"name": "Mailer", "color": "blueBright"},
         {"name": "Cold Call", "color": "yellowBright"},
         {"name": "Referral", "color": "purpleBright"},
         {"name": "Other", "color": "grayBright"},
     ]},
     "description": "Where the lead came from. Website = submitted the offer form "
                    "on gohometownland.com."},
    {"name": "Property State", "type": "singleLineText",
     "description": "State the land is in, as chosen on the website form."},
    {"name": "Property County", "type": "singleLineText",
     "description": "County as the seller typed it. Plain text on purpose: the County "
                    "link field points at Mailers records (mail campaigns), and a "
                    "website lead did not come from a mailer."},
    {"name": "Parcel / APN", "type": "singleLineText",
     "description": "Parcel or APN given by the seller. Optional on the form."},
    {"name": "Ownership", "type": "singleSelect",
     "options": sel("I am on the deed", "I inherited it", "It is in probate",
                    "I own a partial interest")},
    {"name": "Road Access", "type": "singleSelect",
     "options": sel("Paved road", "Dirt or gravel road", "No legal access", "Not sure")},
    {"name": "Timeline", "type": "singleSelect",
     "options": sel("As soon as possible", "Within one to three months",
                    "Within three to six months", "Only if the number is right")},
    {"name": "Best Time", "type": "singleSelect",
     "options": sel("Morning", "Afternoon", "Evening")},
    {"name": "SMS Consent", "type": "singleSelect",
     "options": {"choices": [{"name": "Yes", "color": "greenBright"},
                             {"name": "No", "color": "grayBright"}]},
     "description": "Whether the seller ticked the box agreeing to receive text "
                    "messages (A2P 10DLC / TCPA opt-in record)."},
    {"name": "SMS Consent At", "type": "dateTime",
     "options": {"dateFormat": {"name": "us"}, "timeFormat": {"name": "12hour"},
                 "timeZone": "America/New_York"},
     "description": "When the seller gave SMS consent, for the TCPA record."},
]

# Fields that were already in the CRM before the website existed. /api/lead
# writes them but must not invent them — a missing one here means somebody
# renamed a field the sales team relies on, which is a conversation, not a fix.
LEAD_EXISTING = [
    "Caller Name", "Phone", "Acres", "Sales Stage",
    "Are you interested in selling your land? ",  # the trailing space is real
    "Deal/Property Notes", "Contact", "Reference Number",
]
CONTACT_EXISTING = [
    "First Name", "Last name",
    "Email ",  # so is this one
    "Phone Number", "Contact Type",
]


def call(method, url, payload=None):
    req = urllib.request.Request(
        url, method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        if e.code == 403:
            sys.exit(
                f"403 from Airtable.\n"
                f"Your token does not have permission on base {BASE_ID}.\n"
                f"Check: the token has schema.bases:read (and schema.bases:write for\n"
                f"--create), the base is added to the token's scope, and your user is a\n"
                f"creator on that base rather than read-only.\n\n{detail}")
        sys.exit(f"{e.code} from Airtable: {detail}")


def find_table(tables, wanted):
    for t in tables:
        if t["id"] == wanted or t["name"].lower() == wanted.lower():
            return t
    sys.exit(f'No table called "{wanted}" in base {BASE_ID}. '
             f'Found: {", ".join(t["name"] for t in tables)}')


def main():
    if not TOKEN:
        sys.exit("AIRTABLE_TOKEN is not set. See the docstring at the top of this file.")
    create = "--create" in sys.argv

    meta = f"https://api.airtable.com/v0/meta/bases/{BASE_ID}/tables"
    tables = call("GET", meta)["tables"]

    leads = find_table(tables, LEADS_TABLE)
    contacts = find_table(tables, CONTACTS_TABLE)
    have = {f["name"] for f in leads["fields"]}
    have_contact = {f["name"] for f in contacts["fields"]}

    print(f'Base {BASE_ID}')
    print(f'  Leads    "{leads["name"]}" ({leads["id"]})')
    print(f'  Contacts "{contacts["name"]}" ({contacts["id"]})\n')

    problems = 0

    missing_existing = [n for n in LEAD_EXISTING if n not in have]
    missing_existing += [f"Contacts.{n}" for n in CONTACT_EXISTING if n not in have_contact]
    if missing_existing:
        problems += len(missing_existing)
        print("Renamed or removed since the integration was written — /api/lead will")
        print("drop these values. Fix the name in Airtable or in src/api/lead.js:")
        for name in missing_existing:
            print(f"  ! {name}")
        print()

    missing = [f for f in LEAD_FIELDS if f["name"] not in have]
    for f in LEAD_FIELDS:
        if f["name"] in have:
            print(f'  ok      {f["name"]}')
    for f in missing:
        print(f'  MISSING {f["name"]}')

    if missing and not create:
        print(f"\n{len(missing)} field(s) missing. Re-run with --create to add them.")
        return 1 if problems else 0

    for f in missing:
        call("POST", f"https://api.airtable.com/v0/meta/bases/{BASE_ID}/tables/"
                     f"{leads['id']}/fields", f)
        print(f'  created {f["name"]}')

    if not missing and not problems:
        print("\nEverything /api/lead writes is present. Nothing to do.")

    print("\nSet these in Vercel > Settings > Environment Variables:")
    print( "  AIRTABLE_TOKEN   = (the same token you just used)")
    print(f"  AIRTABLE_BASE_ID = {BASE_ID}    (optional; this is the default)")
    print(f"  AIRTABLE_TABLE   = {LEADS_TABLE}    (optional; this is the default)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
