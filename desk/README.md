# Call Desk

When someone calls your Quo line, their card is on screen before you say hello:
who they are, what you offered them, and what the parcel is.

It runs on your own computer. **The mailer files never leave the machine** — the
only thing that crosses the network is the caller's ten-digit phone number,
arriving from the relay. Owner names, addresses, offer prices and DNC flags stay
on your hard drive.

```
Quo  ──call.ringing──▶  /api/call-relay        (on gohometownland.com)
                              ▲
                              │ the desk asks "anyone calling?" every 2s
                              │
                        Call Desk on your laptop  ──▶  browser tab
```

Nothing reaches *into* your computer. The desk always dials out, so there are no
ports to open and no firewall changes.

---

## One-time setup

### 1. Turn on the relay

In **Vercel → the gohometownland project → Settings → Environment Variables**, add:

| Name | Value |
| --- | --- |
| `CALL_RELAY_KEY` | A long random string you invent. Treat it like a password. |
| `QUO_INBOX_ID` | `PNu6laiBJX` — optional, this is already the default |

Then **Storage → add Upstash Redis** from the Vercel dashboard. It sets
`KV_REST_API_URL` and `KV_REST_API_TOKEN` for you.

> Without the Redis step the relay still answers, but it holds the call in
> memory. Vercel runs many copies of the endpoint, so the copy that hears the
> call is usually not the copy the desk asks — and the card will only appear
> sometimes. Add the store.

Redeploy (a `git push` does it), then confirm the endpoint is alive:

```
https://www.gohometownland.com/api/call-relay?key=YOUR_KEY
```

You should see `{"ok":true,"call":null}`. If it says `bad key`, the value does
not match. If it says `relay not configured`, the variable did not save.

### 2. Point Quo at it

In Quo → **Settings → Integrations → Webhooks**, create a webhook for calls:

- **URL** — `https://www.gohometownland.com/api/call-relay?key=YOUR_KEY`
- **Event** — `call.ringing`
- **Number** — your Primary inbox, (866) 520-9045

Leave any existing Make webhook alone if you still want it; Quo can post to
several places at once.

### 3. Set up the desk

Copy `config.example.json` to `config.json` and fill it in:

```json
{
  "relay_url": "https://www.gohometownland.com/api/call-relay",
  "relay_key": "the same long random string",
  "land_portal_token": "your Land Portal API v2 key",
  "port": 8322
}
```

`config.json` is ignored by git, so your keys cannot end up in the public
repository. The Land Portal token is optional — leave it out and the parcel
detail comes from the mailer file alone.

### 4. Add your mailer files

Drop the CSV exports into the `desk/mailers/` folder. That folder is ignored by
git too.

---

## Running it

```
cd desk
python3 calldesk.py
```

It opens a browser tab at `http://127.0.0.1:8322/`. **Leave both the terminal
window and the tab open all day** — a closed tab cannot pop a card.

To stop it, press `Ctrl+C` in the terminal.

### Day to day

- **A call comes in** → the card appears on its own.
- **No card?** Ask for the reference on their letter (`V001-150`) and type it in
  the search box. It also matches owner name, parcel address and APN.
- **`/`** jumps to the search box, **`Esc`** clears the screen.
- **Test a call** in the header lets you rehearse a record without anyone
  dialling.
- **Mailer files → Reload from folder** picks up newly added CSVs without a
  restart.

### What gets saved

| | |
| --- | --- |
| `desk/logs/calls.csv` | One row per saved call: who, what you offered, the outcome, your notes. Opens in Excel. |
| `desk/cache/parcels.json` | Land Portal responses, kept so a repeat caller never costs a second request against your quota. |

Delete the cache file if you want fresh parcel data.

---

## If something is wrong

**Header says "Manual lookup only"** — no `relay_url` in `config.json`. The desk
still works for reference lookups; calls just will not pop.

**"Relay rejected the key"** — `relay_key` here and `CALL_RELAY_KEY` on Vercel
are different strings.

**"Cannot reach the relay"** — the endpoint is not deployed, or you are offline.
Open the relay URL in a browser to check.

**Card appears only sometimes** — Upstash Redis is not set up. See step 1.

**A call rings but no card appears** — check the terminal window. It prints a
line for every call it sees. If nothing prints, the event is not reaching the
relay; check the webhook in Quo.

**"No mailer match" for someone you definitely mailed** — they are calling from
a number that was not in the export, or that campaign's CSV is not in
`desk/mailers/`. Look them up by reference.

---

## A word about the data

The mailer exports carry names, home addresses, personal phone numbers, email
addresses and Do-Not-Call flags for several hundred real people.

**The gohometownland repository is public**, and git keeps history forever — a
file committed by accident cannot be un-published by deleting it later. The
`.gitignore` blocks `desk/mailers/`, `desk/cache/`, `desk/logs/`,
`desk/config.json` and every `.csv` in the project for that reason. Do not force
past it.
