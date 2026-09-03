"""Create the "Website Leads" table that /api/lead writes into.

Run once, after your Airtable user has creator access to the base. The site's
endpoint expects exactly these field names — change one here and change it in
src/api/lead.js too.

    set AIRTABLE_TOKEN=pat...        (Windows CMD)
    $env:AIRTABLE_TOKEN="pat..."     (PowerShell)
    export AIRTABLE_TOKEN=pat...     (bash)

    python scripts/setup-airtable.py

The token needs scopes: schema.bases:write and data.records:write, and must be
granted access to the base below.
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE_ID = os.environ.get("AIRTABLE_BASE_ID", "appRHIBoV93IBxirZ")
TABLE_NAME = os.environ.get("AIRTABLE_TABLE", "Website Leads")
TOKEN = os.environ.get("AIRTABLE_TOKEN")

def sel(*names):
    return {"choices": [{"name": n} for n in names]}

FIELDS = [
    # primary field first
    {"name": "Name", "type": "singleLineText"},
    {"name": "Email", "type": "email"},
    {"name": "Phone", "type": "phoneNumber"},
    {"name": "State", "type": "singleLineText"},
    {"name": "County", "type": "singleLineText",
     "description": "Plain text on purpose. The existing Leads table links County to a "
                    "record; a web form has no way to match one, so this stays free text."},
    {"name": "Parcel / APN", "type": "singleLineText"},
    {"name": "Acres", "type": "number", "options": {"precision": 2}},
    {"name": "Ownership", "type": "singleSelect",
     "options": sel("I am on the deed", "I inherited it", "It is in probate",
                    "I own a partial interest")},
    {"name": "Road Access", "type": "singleSelect",
     "options": sel("Paved road", "Dirt or gravel road", "No legal access", "Not sure")},
    {"name": "Timeline", "type": "singleSelect",
     "options": sel("As soon as possible", "Within one to three months",
                    "Within three to six months", "Only if the number is right")},
    {"name": "Best Time", "type": "singleSelect", "options": sel("Morning", "Afternoon", "Evening")},
    {"name": "Notes", "type": "multilineText"},
    {"name": "Received", "type": "dateTime",
     "options": {"dateFormat": {"name": "us"}, "timeFormat": {"name": "12hour"},
                 "timeZone": "America/New_York"}},
    {"name": "Source", "type": "singleSelect", "options": sel("Website")},
    {"name": "SMS Consent", "type": "singleSelect", "options": sel("Yes", "No"),
     "description": "Whether the lead checked the box agreeing to receive text messages "
                    "(A2P 10DLC / TCPA opt-in record)."},
    {"name": "SMS Consent At", "type": "dateTime",
     "options": {"dateFormat": {"name": "us"}, "timeFormat": {"name": "12hour"},
                 "timeZone": "America/New_York"}},
    {"name": "Status", "type": "singleSelect",
     "options": {"choices": [
         {"name": "New", "color": "blueBright"},
         {"name": "Researching", "color": "yellowBright"},
         {"name": "Offer Sent", "color": "purpleBright"},
         {"name": "Negotiating", "color": "orangeBright"},
         {"name": "Under Contract", "color": "greenBright"},
         {"name": "Closed", "color": "greenDark1"},
         {"name": "Passed", "color": "grayBright"},
     ]}},
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
                f"Check: the token has schema.bases:write and data.records:write,\n"
                f"the base is added to the token's scope, and your user is a creator\n"
                f"on that base rather than read-only.\n\n{detail}")
        sys.exit(f"{e.code} from Airtable: {detail}")


def main():
    if not TOKEN:
        sys.exit("AIRTABLE_TOKEN is not set. See the docstring at the top of this file.")

    meta = f"https://api.airtable.com/v0/meta/bases/{BASE_ID}/tables"

    existing = {t["name"]: t["id"] for t in call("GET", meta)["tables"]}
    if TABLE_NAME in existing:
        print(f'"{TABLE_NAME}" already exists ({existing[TABLE_NAME]}). Nothing to do.')
        print("\nSet these in Vercel:")
        print(f"  AIRTABLE_BASE_ID = {BASE_ID}")
        print(f"  AIRTABLE_TABLE   = {TABLE_NAME}")
        return

    created = call("POST", meta, {
        "name": TABLE_NAME,
        "description": "Offer requests from gohometownland.com, written by /api/lead.",
        "fields": FIELDS,
    })

    print(f'Created "{TABLE_NAME}" -> {created["id"]}')
    print(f"  {len(FIELDS)} fields")
    print("\nSet these in Vercel > Settings > Environment Variables:")
    print(f"  AIRTABLE_BASE_ID = {BASE_ID}")
    print(f"  AIRTABLE_TABLE   = {TABLE_NAME}")
    print( "  AIRTABLE_TOKEN   = (the same token you just used)")


if __name__ == "__main__":
    main()
