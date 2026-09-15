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
- **Number** — your Primary inbox, (866) 520-9045

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
  "port": 8322
}
```

Until `relay_key` is filled in, the desk runs in look-up-only mode: search and
**Test a call** work, but calls will not pop by themselves.

`config.json` is ignored by git, so your keys cannot reach the public
repository.

### 5. Add your mailer files

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
