# Call Desk

When someone calls your Quo line, their card is on screen before you say hello:
who they are, what you offered them, and what the parcel is.

It runs on your own computer, and a copy of the records also lives on the
site so you can use it **from your phone** — at
`https://www.gohometownland.com/desk` — and get **a text on your cell** with
the deal and parcel details the moment a call rings. Both of those work with
the laptop shut.

```
Quo  ──call.ringing──▶  /api/call-relay  ──text──▶  your cell (via Quo)
                              ▲     │
                              │     └── looks the caller up in the cloud copy
                              │ the desk asks "anyone calling?" every 2s
                              │
                        Call Desk on your laptop  ──▶  browser tab
                              │
                              └── sends its records ──▶  /api/desk  ◀── /desk on your phone
```

Nothing reaches *into* your computer. The desk always dials out, so there are no
ports to open and no firewall changes.

**What leaves the laptop.** Each time the desk starts, or you press **Reload
from folder**, it sends the mailer records to the site's own private Redis
store — the same one the relay already uses. That copy is what the phone page
and the texts read. It is never written to the repository, and every read of
it needs your desk key. The call log (`calls.csv`) stays on the laptop. To
keep the records on the laptop only, put `"cloud_sync": false` in
`config.json`; the phone page and the texts will then know nothing about them.

---

## One-time setup

### 1. Turn on the relay

In **Vercel → the gohometownland project → Settings → Environment Variables**, add:

| Name | Value |
| --- | --- |
| `CALL_RELAY_KEY` | A long random string. Treat it like a password — see below. |
| `QUO_INBOX_ID` | `PNu6laiBJX` — optional, this is already the default |

**The key must be long and random.** The relay sits on a public domain, so a
guessable value lets anyone see who is calling you and pop false cards on your
screen. Something like `openssl rand -hex 24` output, not a phrase built from
your company name.

Then **Storage → add Redis** from the Vercel dashboard. Whichever provider you
pick sets the variables for you, and the relay takes any of them:

| Variables | How it is reached |
| --- | --- |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | HTTPS |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | HTTPS |
| `REDIS_URL` or `KV_URL` (`redis://`, `rediss://`) | a socket, speaking the Redis protocol |

So there is nothing to match up by hand, and no need to prefer one provider.

> Without a store the relay still answers, but it holds the call in memory.
> Vercel runs many copies of the endpoint, so the copy that hears the call is
> usually not the copy the desk asks — and the card will only appear
> *sometimes*, which reads like a flaky bug rather than a missing setting.

**The relay only exists once its code is on `main`.** Vercel publishes `main` to
gohometownland.com; any other branch gets a preview URL instead. Merge first,
then visit:

```
https://www.gohometownland.com/api/call-relay?key=YOUR_KEY
```

| What you see | What it means |
| --- | --- |
| `{"ok":true,"call":null,"store":"redis"}` | Working, over a socket. This is the one you want. |
| `…"store":"upstash"` or `"vercel-kv"` | Working, over HTTPS. Also fine. |
| `…"store":"memory"` | No store found. Cards will be missed. Add Redis. |
| `{"ok":false,"error":"bad key"}` | The key in the URL is not `CALL_RELAY_KEY`. |
| `{"ok":false,"error":"relay not configured"}` | `CALL_RELAY_KEY` did not save. |
| A 404 page | Not deployed — the code is not on `main` yet. |

The desk shows the same thing: if the header reads **"Listening — add Redis,
cards will be missed"**, the store is not wired up.

**If it says `"store":"memory"`,** add `&diag=1` to that URL. It lists which
credentials the deployment can actually see — names only, never values:

```
https://www.gohometownland.com/api/call-relay?key=YOUR_KEY&diag=1
```

- `related` is empty → the store is not connected to **this project**, or the
  deployment predates the connection. Connect it, then redeploy.
- `related` lists a name the relay does not recognise → send me the names, not
  the values, and it can be added.

`"store":"memory (redis unreachable)"` means the URL was found but the server
refused it — usually a password that has been rotated since the variable was
set.

Environment variables only reach a **new** deployment. After changing anything,
redeploy from **Deployments → ⋯ → Redeploy**.

### 2. Point Quo at it

In Quo → **Settings → Integrations → Webhooks**, create a webhook for calls:

- **URL** — `https://www.gohometownland.com/api/call-relay?key=YOUR_KEY`
- **Event** — `call.ringing`
- **Numbers** — both lines: (866) 520-9045 and (781) 579-8849

The relay accepts calls to either line (set `QUO_INBOX_ID` to a comma-separated
list of `PN…` ids to change which). The card and the text both say which line
was dialled.

Leave any existing Make webhook alone if you still want it; Quo can post to
several places at once.

### 3. Start the desk

Double-click **`Start Call Desk.bat`** in the `desk` folder.

The first run writes its own `config.json` and opens
`http://127.0.0.1:8322/` in your browser. Nothing to install and nothing to
rename.

If Windows says Python is missing, the window tells you so and links to
<https://www.python.org/downloads/>. During that install **tick "Add python.exe
to PATH"** — without it Windows cannot find Python and the launcher will keep
saying the same thing.

### 4. Add your relay key

Open `config.json` in the `desk` folder (Notepad is fine):

```json
{
  "relay_url": "https://www.gohometownland.com/api/call-relay",
  "relay_key": "paste your CALL_RELAY_KEY here",
  "land_portal_token": "optional - your Land Portal API v2 key",
  "port": 8322,
  "cloud_sync": true
}
```

Until `relay_key` is filled in, the desk runs in look-up-only mode: search and
**Test a call** work, but calls will not pop by themselves.

`config.json` is ignored by git, so your keys cannot reach the public
repository.

### 5. Phone desk and texts (optional, recommended)

All of this is in **Vercel → the gohometownland project → Settings →
Environment Variables**. Redeploy after adding them (Deployments → ⋯ →
Redeploy).

| Name | Value |
| --- | --- |
| `DESK_KEY` | The password the phone page asks for. Long and random, like the relay key — this one opens owner names and offers. Without it, the phone page takes `CALL_RELAY_KEY` instead. |
| `QUO_API_KEY` | From Quo → **Settings → API**. Lets the site send texts from your Quo line. |
| `CALL_TEXT_TO` | Your cell number, e.g. `2695551234`. |
| `CALL_TEXT_FROM` | Optional. Which Quo line sends the text — its `PN…` id or its number. Default: your Primary inbox. |
| `CALL_TEXT` | Optional. `all` (default) texts every call, `matched` only callers found in your mailers, `off` none. |

Quo charges for the texts it sends through the API as it does for any other
text. If Quo has not finished registering your line for texting (carrier
registration), the texts will be refused until it has — the relay keeps
working either way.

**On the iPhone:** open `https://www.gohometownland.com/desk` in Safari, enter
the desk key, then **Share → Add to Home Screen**. It opens full screen like
an app. The home-screen copy asks for the key once more, because iOS keeps it
apart from Safari.

To check it end to end: start the desk on the laptop (it says `cloud sync:
… records sent to the phone desk`), open the phone page and see the record
count, then call your Quo line from another phone. The text should arrive
while it rings, and the page opens the caller's card on its own.

### 6. Add your mailer files

Drop the CSV exports into the `desk/mailers/` folder, then start the desk again
(or use **Mailer files → Reload from folder**). That folder is ignored by git
too.

---

## Running it

Double-click **`Start Call Desk.bat`**.

**Leave both the black window and the browser tab open all day** — a closed tab
cannot pop a card. To stop, press `Ctrl+C` in the black window, or just close
it.

The black window is also the log: it prints a line for every call it sees,
which is the first place to look when something seems wrong. It stays open
after an error so you can read what happened.

Everything it prints also goes to **`desk/logs/calldesk.log`**, with timestamps
and full detail — including faults in the browser tab, which otherwise leave no
trace at all. That file is what to send when something went wrong an hour ago
and the window has scrolled. It holds references, phone numbers and how long a
note was, never the note itself or an owner's details, and it is ignored by git
like the rest of `desk/logs/`. It rotates at 2 MB and keeps three older files.

For a noisy run that shows every request in the window too, start it with
`py calldesk.py --debug`, or put `"debug": true` in `config.json`. The file
keeps that detail either way.

### After pulling an update

**Restart the desk.** Close the black window and double-click the launcher
again.

The desk reads its screen off disk every time the page loads, but the program
itself is whatever was running when you opened the window. Update without
restarting and you get a new screen talking to the old program, which fails in
ways that look like nothing in this file. It now notices: a red bar appears
across the top saying the program is still the old one, and saving a note says
the same thing instead of something about `id`. Restart and both go away.

### Day to day

- **A call comes in** → the card appears on its own.
- **No card?** Ask for the reference on their letter (`V001-150`) and type it in
  the search box. It also matches owner name, parcel address and APN.
- **They hang up** → press **Hang up** and the card *stays where it is*, with the
  cursor already in the notes box. Write down what was said, pick an outcome,
  and press **Save to log**. Only **Clear** puts the card away, and it asks first
  if there is a note you have not saved.
- **Something turns up afterwards** → the deed arrives, the lawyer calls back.
  The call is still on screen under **This record in the call log**, and every
  saved call is under **Call log** in the header. Open one, press **Add detail**,
  and what you write is filed under its own timestamp beneath the original note.
  Nothing you wrote during the call is overwritten.
- **`/`** jumps to the search box, **`Esc`** clears the screen — except in a
  notes box, where it just stops typing.
- **Test a call** in the header lets you rehearse a record without anyone
  dialling.
- **Mailer files → Reload from folder** picks up newly added CSVs without a
  restart.

### On your phone

`https://www.gohometownland.com/desk` (or the home-screen icon):

- **A call rings** → a green bar appears and the caller's card opens on its
  own, if the page is open. With the page closed, the text is what reaches you.
- **The text** → caller, reference, owner, offer and offer/acre, market value
  and market/acre, TLP estimate, retail, profit, acres, parcel address, county,
  APN, zoning, terrain, dates, and a Land Portal link. Its last line opens the
  full card. A number that is not in any mailer gets a short "no match" text.
- **Search** works like the laptop: reference, name, parcel address, APN, or
  any of their phone numbers.
- **Recent calls** lists the last 30 calls the relay saw, matched or not.
- **Text me this** on any card sends that card to your cell — handy before
  returning a call.

The phone page reads the copy the laptop last sent. New CSVs reach it the next
time the desk starts or you press **Reload from folder**; the header in
**Mailer files** says when that last happened. Notes are still written on the
laptop.

### Document Builder

**Documents** in the header opens the Document Builder at
`http://127.0.0.1:8322/docs`. It reads the same `desk/mailers` folder as the
desk. Type a reference (`MI-04-093`), press **Look up & fill**, and the county,
parcel address, offer price, acreage, APN and closing date come straight from
the mailer file. Nothing needs uploading. If a reference was mailed more than
once, the newest file wins, the same as on the card. Anything the file leaves
blank is named on screen so you can fill it by hand.

Every card also has a **Sales contract** button that opens the builder with
that record already filled in.

New CSVs in the folder show up after **Reload from folder**. The builder only
reads the folder while the desk is running. Opened by double-clicking
`desk/ui/docs.html` instead, it asks you to choose the `mailers` folder once
(Chrome or Edge) and remembers it. **Use a different CSV instead** still takes
a one-off file.

### What gets saved

| | |
| --- | --- |
| `desk/logs/calls.csv` | One row per saved call: who, what you offered, the outcome, and the notes — the ones written on the call and everything added since, each with the time it was written. Opens in Excel. |
| `desk/cache/parcels.json` | Land Portal responses, kept so a repeat caller never costs a second request against your quota. |
| `desk/logs/calldesk.log` | What the desk did, and anything that went wrong, with timestamps. Troubleshooting only — no note text and no owner details. |

Delete the cache file if you want fresh parcel data. Leave `calls.csv` alone:
adding a detail to a call rewrites that file, so the desk needs the whole thing.
An older `calls.csv` written before the log could be added to still opens
normally — the first time the desk reads it, the two new columns are filled in
and those calls can be topped up like any other.

---

## If something is wrong

**Header says "Manual lookup only"** — `relay_key` is still empty in
`config.json`. The desk works for look-ups; calls just will not pop.

**Double-clicking the launcher flashes a window and closes** — that means it
could not even start Python. Open the `desk` folder, hold Shift, right-click in
the empty space, choose **Open PowerShell window here**, and run
`py calldesk.py` to see the error.

**"Relay rejected the key"** — `relay_key` here and `CALL_RELAY_KEY` on Vercel
are different strings.

**"Cannot reach the relay"** — the endpoint is not deployed, or you are offline.
Open the relay URL in a browser to check.

**Card appears only sometimes** — Upstash Redis is not set up. See step 1.

**A call rings but no card appears** — check the terminal window. It prints a
line for every call it sees. If nothing prints, the event is not reaching the
relay; check the webhook in Quo.

**A red bar says the program is from before the last update** — exactly that:
close the black window and start it again. Nothing is lost; a note in the box
stays in the box.

**"The desk did not confirm the save"** — the note was not written, and it is
still in the box so you can try again. `desk/logs/calldesk.log` says why.

**Phone page says "No records synced yet"** — the laptop has not sent them.
Open **Mailer files** on the laptop: the line under the file list says why
("the site rejected the relay key", "the site has not been updated yet", …).

**No text when a call rings** — open the phone page: the line under Recent
calls says if texting is off. If the call shows in Recent calls but no text
came, the Vercel function log for `/api/call-relay` has a `text failed:` line
with Quo's reason.

**Anything else odd** — open `desk/logs/calldesk.log` and look at the end. Every
request, every saved call and every error is there with the time it happened.

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

The phone desk keeps its copy of those records in the Vercel project's Redis,
not in git. Only someone holding `DESK_KEY` (or the relay key) can read it, so
treat both like passwords.
