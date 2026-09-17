/* Hometown Land Call Desk.
 *
 * All data comes from the local server on 127.0.0.1 — the mailer files never
 * leave the machine. The page polls /api/state; when the relay reports a
 * ringing call, the card replaces whatever was on screen.
 */
(function () {
  "use strict";

  var POLL_MS = 1000;
  var seq = null;          // changes whenever the server has something new
  var mode = "idle";       // idle | call | manual | picker
  var timer = null;

  /* Must match DESK_VERSION in calldesk.py.

     The desk reads this file off disk on every request, but the Python it is
     running was loaded when the window was opened. Pulling an update without
     restarting therefore runs this page against the server it replaced, and
     the failure that produces is baffling: a reply arrives, looks fine, and
     is missing a field this page is certain is there. Rather than let that
     surface as a stray TypeError, the two say their version to each other. */
  var UI_VERSION = "2026.09.17";
  var stale = false;       // true once the server has answered with another one

  /* ---------- telling the desk what went wrong here ----------

     Most of this desk runs in the tab, which was the one place the log could
     not see: a fault here lived in a devtools console nobody had open. These
     go to the same file as everything the server does. Never let reporting a
     fault raise one -- it would report itself forever. */
  var REPEAT_MS = 60000;
  var reported = Object.create(null);   // bare, so "constructor" is not a hit

  function report(level, message, detail) {
    try {
      /* The poll runs every second, so a desk that has stopped answering
         would write a line a second until someone noticed. The same thing is
         said once a minute instead: often enough to show it is still
         happening, rarely enough to leave the rest of the morning readable. */
      var key = level + "|" + message;
      var now = Date.now();
      if (reported[key] && now - reported[key] < REPEAT_MS) return;
      reported[key] = now;
      fetch("/api/client-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          level: level,
          message: String(message).slice(0, 1000),
          detail: detail
        })
      }).catch(function () {});
    } catch (e) { /* nothing left to report it to */ }
  }

  window.addEventListener("error", function (e) {
    report("error", (e.message || "script error"), {
      at: (e.filename || "") + ":" + (e.lineno || 0) + ":" + (e.colno || 0),
      stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 1200) : "",
      mode: mode, ui: UI_VERSION
    });
  });

  window.addEventListener("unhandledrejection", function (e) {
    var why = e.reason;
    report("error", "unhandled rejection: " + ((why && why.message) || why), {
      stack: why && why.stack ? String(why.stack).slice(0, 1200) : "",
      mode: mode, ui: UI_VERSION
    });
  });

  /* What is true about the card on screen but not in the markup: how far the
     call has got, how long it has run, the notes being typed, and the log row
     they belong to once saved. The card is re-rendered whenever Land Portal
     answers, so this has to live outside it -- otherwise enrichment landing
     mid-sentence would wipe the note. */
  var cardState = null;

  var OUTCOMES = ["Accepted", "Countered", "Thinking", "Not selling",
                  "Wrong number", "Remove from list"];
  var OUTCOME_TONE = {
    "Accepted": "good", "Countered": "live", "Thinking": "live",
    "Not selling": "alert", "Remove from list": "alert"
  };

  /* ---------- helpers ---------- */

  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function digits(s) {
    var d = String(s || "").replace(/\D/g, "");
    if (d.length === 11 && d[0] === "1") d = d.slice(1);
    return d;
  }

  function fmtPhone(d) {
    d = digits(d);
    return d.length === 10
      ? "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6)
      : (d || "—");
  }

  function usd(n, dec) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    var p = dec === undefined ? 2 : dec;
    return "$" + Number(n).toLocaleString("en-US",
      { minimumFractionDigits: p, maximumFractionDigits: p });
  }

  function usd0(n) { return usd(n, 0); }

  function titleCase(s) {
    return String(s || "").toLowerCase()
      .replace(/\b([a-z])/g, function (m, c) { return c.toUpperCase(); });
  }

  function pct(a, b) { return (b && a) ? Math.round(a / b * 100) + "%" : "—"; }

  function api(path, body) {
    var opts = body
      ? { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body) }
      : {};
    return fetch(path, opts).catch(function (err) {
      // Nothing answered at all -- the desk is stopped, or the port moved.
      // Caught here rather than around the whole chain, so a fault in our own
      // handling below is not mistaken for the network.
      report("warning", "could not reach the desk: " + path,
             { why: String(err && err.message || err), mode: mode });
      throw err;
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        // The desk says why it refused -- "that call is no longer in the log"
        // is worth showing instead of a status code.
        if (!r.ok) {
          // /api/client-log is excluded: a failure reporting a failure would
          // report itself.
          if (path !== "/api/client-log") {
            report(r.status >= 500 ? "error" : "warning",
                   "request failed: " + path,
                   { status: r.status, error: data.error || "", mode: mode });
          }
          throw new Error(data.error || "HTTP " + r.status);
        }
        return data;
      });
    });
  }

  /* The desk is older than this page. Every reply is then suspect, so say so
     once, plainly, in the words of the thing that fixes it. */
  function staleMessage() {
    return "The Call Desk program is still running the version from before " +
      "the last update. Close the black window and start it again.";
  }

  var stage = document.getElementById("stage");

  /* ---------- parcel drawing ---------- */

  var W = 320, H = 170;

  function grid() {
    var g = "";
    for (var x = 20; x < W; x += 32)
      g += '<line x1="' + x + '" y1="0" x2="' + x + '" y2="' + H + '" stroke="currentColor" stroke-width="1" opacity=".12"/>';
    for (var y = 17; y < H; y += 32)
      g += '<line x1="0" y1="' + y + '" x2="' + W + '" y2="' + y + '" stroke="currentColor" stroke-width="1" opacity=".12"/>';
    return '<g color="var(--text-faint)">' + g + "</g>";
  }

  /* Land Portal returns a Polygon or MultiPolygon; take the largest ring. */
  function outerRing(geometry) {
    if (!geometry) return null;
    var polys = geometry.type === "MultiPolygon" ? geometry.coordinates
      : geometry.type === "Polygon" ? [geometry.coordinates] : null;
    if (!polys || !polys.length) return null;
    var best = null;
    polys.forEach(function (poly) {
      var ring = poly && poly[0];
      if (ring && ring.length > 2 && (!best || ring.length > best.length)) best = ring;
    });
    return best;
  }

  function realParcel(ring) {
    var pad = 30;
    var lats = ring.map(function (p) { return p[1]; });
    var lons = ring.map(function (p) { return p[0]; });
    var minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
    var minLon = Math.min.apply(null, lons), maxLon = Math.max.apply(null, lons);
    var k = Math.cos((minLat + maxLat) / 2 * Math.PI / 180);
    var dx = (maxLon - minLon) * k, dy = maxLat - minLat;
    var scale = Math.min((W - pad * 2) / (dx || 1), (H - pad * 2) / (dy || 1));
    var ox = (W - dx * scale) / 2, oy = (H - dy * scale) / 2;

    var pts = ring.map(function (p) {
      return [((p[0] - minLon) * k * scale + ox).toFixed(1),
              (H - ((p[1] - minLat) * scale + oy)).toFixed(1)].join(",");
    }).join(" ");

    var barPx = 100 / 364567 * scale, bar = "";
    if (barPx > 12 && barPx < W - 70) {
      var x2 = (14 + barPx).toFixed(1);
      bar = '<g><line x1="14" y1="' + (H - 14) + '" x2="' + x2 + '" y2="' + (H - 14) + '" stroke="var(--text-dim)" stroke-width="2"/>' +
        '<line x1="14" y1="' + (H - 18) + '" x2="14" y2="' + (H - 10) + '" stroke="var(--text-dim)" stroke-width="2"/>' +
        '<line x1="' + x2 + '" y1="' + (H - 18) + '" x2="' + x2 + '" y2="' + (H - 10) + '" stroke="var(--text-dim)" stroke-width="2"/>' +
        '<text x="' + (16 + barPx).toFixed(1) + '" y="' + (H - 10) + '" fill="var(--text-faint)" font-family="IBM Plex Mono, monospace" font-size="9">100 ft</text></g>';
    }

    return '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Surveyed parcel boundary">' +
      grid() +
      '<polygon points="' + pts + '" fill="var(--live)" fill-opacity=".16" stroke="var(--live)" stroke-width="2" stroke-linejoin="round"/>' +
      '<g><line x1="' + (W - 20) + '" y1="28" x2="' + (W - 20) + '" y2="12" stroke="var(--text-dim)" stroke-width="1.5"/>' +
      '<polygon points="' + (W - 20) + ",8 " + (W - 23.5) + ",15 " + (W - 16.5) + ',15" fill="var(--text-dim)"/>' +
      '<text x="' + (W - 20) + '" y="40" text-anchor="middle" fill="var(--text-faint)" font-family="IBM Plex Mono, monospace" font-size="9">N</text></g>' +
      bar + "</svg>" +
      '<div class="cap">Surveyed boundary · Land Portal</div>';
  }

  function schematic(lead) {
    var ac = lead.calcAcres || lead.acres || 1;
    var cx = W / 2, cy = H / 2;
    var side = Math.max(34, Math.min(84, Math.sqrt(ac) * 34));
    var pw = side * 1.25, ph = side * 0.8;
    return '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Schematic parcel">' +
      grid() +
      '<rect x="' + (cx - pw / 2) + '" y="' + (cy - ph / 2) + '" width="' + pw + '" height="' + ph +
      '" fill="var(--text-faint)" fill-opacity=".12" stroke="var(--text-faint)" stroke-width="2" stroke-dasharray="6 4"/>' +
      '<text x="' + cx + '" y="' + (cy - ph / 2 - 9) + '" text-anchor="middle" fill="var(--text-dim)" font-family="IBM Plex Mono, monospace" font-size="11">' + esc(ac) + " ac</text></svg>" +
      '<div class="cap">Schematic · sized from acreage</div>';
  }

  function locator(lead, parcel) {
    var ring = parcel && outerRing(parcel.geometry);
    if (ring) return realParcel(ring);
    if (lead.lat === null || lead.lat === undefined) return "";
    return schematic(lead);
  }

  /* ---------- the card ---------- */

  function card(lead, phone, parcel, kind, number) {
    var name = titleCase(lead.greet || lead.owner);
    var acres = lead.calcAcres || lead.acres;
    var parcelLine = [lead.pAddr, lead.pCity, lead.pState + " " + lead.pZip].filter(Boolean).join(", ");
    var mailLine = [lead.mAddr, lead.mCity, lead.mState + " " + lead.mZip].filter(Boolean).join(", ");
    var absentee = (lead.mCity || "").toLowerCase() !== (lead.pCity || "").toLowerCase();
    var max = Math.max(lead.retail || 0, lead.tlp || 0, lead.offer || 0) || 1;
    parcel = parcel || {};

    var badges = "";
    if (phone) badges += '<span class="badge live">' + esc(phone.label) + " · " + esc(phone.type || "Unknown") + "</span>";
    if (phone && phone.dnc) badges += '<span class="badge alert">DNC — they called you</span>';
    if (lead.mailer) badges += '<span class="badge">Mailer #' + esc(lead.mailer) + "</span>";
    badges += '<span class="badge">Ref ' + esc(lead.ref) + "</span>";
    if (absentee) badges += '<span class="badge good">Absentee owner</span>';

    var alts = (lead.phones || []).filter(function (p) { return !phone || p.num !== phone.num; });
    var best = phone || (lead.phones || [])[0];

    var strip = kind === "call"
      ? '<div class="strip" id="strip">' +
          '<span class="lamp"></span>' +
          '<span class="strip-state" id="stripstate">Incoming call</span>' +
          '<span class="strip-num">' + esc(fmtPhone(number)) + "</span>" +
          '<span class="strip-via">via Quo · (866) 520-9045</span>' +
          '<span class="strip-timer" id="timer">00:00</span>' +
          '<span class="strip-acts">' +
            '<button class="act pri" id="answer" type="button">Answer</button>' +
            '<button class="act end" id="hangup" type="button">Hang up</button>' +
          "</span></div>"
      : '<div class="strip answered" id="strip">' +
          '<span class="lamp"></span>' +
          '<span class="strip-state" id="stripstate">Found by reference</span>' +
          '<span class="strip-num">' + esc(lead.ref) + "</span>" +
          '<span class="strip-via">looked up by hand · ' + esc(lead.source || "") + "</span>" +
          '<span class="strip-acts">' +
            (best ? '<a class="act pri" href="tel:+1' + esc(best.num) + '">Call ' + esc(fmtPhone(best.num)) + "</a>" : "") +
            '<button class="act" id="clearbtn" type="button">Clear</button>' +
          "</span></div>";

    var terr = [];
    if (lead.build != null) terr.push(["Buildable", lead.build, lead.build.toFixed(1) + "%", lead.build < 60]);
    if (lead.slope != null) terr.push(["Avg slope", Math.min(lead.slope * 4, 100), lead.slope.toFixed(1) + "%", lead.slope > 10]);
    if (lead.wetlands != null) terr.push(["Wetlands", lead.wetlands, lead.wetlands.toFixed(1) + "%", lead.wetlands > 5]);
    if (lead.flood != null) terr.push(["FEMA flood", lead.flood, lead.flood.toFixed(1) + "%", lead.flood > 5]);

    return strip +
    '<div class="pop">' +

      '<div class="col">' +
        '<div class="coltag">Who is calling<span class="src-pill">Mailer file</span></div>' +
        "<div>" +
          '<div class="who-name">' + esc(name) + "</div>" +
          '<div class="who-sub">Deeded owner: <b>' + esc(titleCase(lead.owner)) + "</b></div>" +
          '<div class="srcline">From ' + esc(lead.source || "mailer file") + "</div>" +
        "</div>" +
        '<div class="badges">' + badges + "</div>" +
        '<div class="script"><span class="k">Answer with</span><p>&ldquo;Hometown Land, this is Brian &mdash; is this ' +
          esc((name.split(/[&,]/)[0] || "").trim()) + "?&rdquo;</p></div>" +
        '<div class="rows">' +
          (kind === "call"
            ? '<div class="row"><span class="k">Calling from</span><span class="v m">' + esc(fmtPhone(number)) + "</span></div>"
            : '<div class="row"><span class="k">Reference</span><span class="v m">' + esc(lead.ref) + "</span></div>") +
          (alts.length ? '<div class="row"><span class="k">Other lines</span><span class="v m">' +
            alts.map(function (p) {
              return esc(fmtPhone(p.num)) + ' <span style="color:var(--text-faint)">' +
                esc(p.type || "") + (p.dnc ? " · DNC" : "") + "</span>";
            }).join("<br>") + "</span></div>" : "") +
          (lead.email ? '<div class="row"><span class="k">Email</span><span class="v m">' + esc(lead.email) + "</span></div>" : "") +
          '<div class="row"><span class="k">Mailing</span><span class="v">' + esc(mailLine) +
            '<br><span style="color:var(--text-faint)">' + esc(lead.mCounty) + "</span></span></div>" +
          '<div class="row"><span class="k">Offer sent</span><span class="v m">' + esc(lead.offerDate) + "</span></div>" +
          '<div class="row"><span class="k">Closes by</span><span class="v m">' + esc(lead.closeDate) + "</span></div>" +
        "</div>" +
      "</div>" +

      '<div class="col">' +
        '<div class="coltag">The numbers<span class="src-pill">Mailer file</span></div>' +
        '<div class="heroes">' +
          '<div class="hero offer"><div class="k">Offer price</div><div class="v">' + esc(usd0(lead.offer)) +
            '</div><div class="s">' + esc(usd0(lead.offerPPA)) + " / acre</div></div>" +
          '<div class="hero tlp"><div class="k">TLP estimate</div><div class="v">' + esc(usd0(lead.tlp)) +
            '</div><div class="s">offer is ' + esc(pct(lead.offer, lead.tlp)) + " of TLP</div></div>" +
        "</div>" +
        '<div class="ladder">' +
          '<span class="cap">Offer against value</span>' +
          '<div class="track">' +
            '<span class="fill" style="width:' + ((lead.offer || 0) / max * 100).toFixed(1) + '%"></span>' +
            '<span class="mark tlp" style="left:' + ((lead.tlp || 0) / max * 100).toFixed(1) + '%"></span>' +
          "</div>" +
          '<div class="legend">' +
            '<div class="lg"><span class="sw" style="background:var(--live)"></span><span class="n">Your offer <span style="color:var(--text-faint)">as mailed</span></span><span class="amt">' + esc(usd(lead.offer)) + '</span><span class="pc">' + esc(pct(lead.offer, max)) + "</span></div>" +
            '<div class="lg"><span class="sw" style="background:var(--portal)"></span><span class="n">TLP estimate</span><span class="amt">' + esc(usd(lead.tlp)) + '</span><span class="pc">' + esc(pct(lead.tlp, max)) + "</span></div>" +
            '<div class="lg"><span class="sw" style="background:var(--text-faint)"></span><span class="n">Retail (90%)</span><span class="amt">' + esc(usd(lead.retail)) + '</span><span class="pc">' + esc(pct(lead.retail, max)) + "</span></div>" +
          "</div>" +
        "</div>" +
        '<div class="stats">' +
          '<div class="st"><div class="k">Acres</div><div class="v">' + esc(acres) + "</div></div>" +
          '<div class="st"><div class="k">Projected profit</div><div class="v good">' + esc(usd0(lead.profit)) + "</div></div>" +
          '<div class="st"><div class="k">Offer $/acre</div><div class="v">' + esc(usd0(lead.offerPPA)) + "</div></div>" +
          '<div class="st"><div class="k">Market $/acre</div><div class="v">' + esc(usd0(lead.realPPA)) + "</div></div>" +
          '<div class="st"><div class="k">Assessed</div><div class="v">' + esc(usd0(lead.assessed)) + "</div></div>" +
          '<div class="st"><div class="k">County market</div><div class="v">' + esc(usd0(lead.market)) + "</div></div>" +
        "</div>" +
      "</div>" +

      '<div class="col col-parcel">' +
        '<div class="coltag">The parcel<span class="src-pill' + (parcel.geometry ? " lp" : "") + '">' +
          (parcel.geometry ? "Land Portal" : "Mailer file") + "</span></div>" +
        '<div class="rows">' +
          '<div class="row"><span class="k">Address</span><span class="v"><b>' + esc(parcelLine) + "</b></span></div>" +
          '<div class="row"><span class="k">County</span><span class="v">' + esc(lead.pCounty) + " County, " + esc(lead.pState) +
            ' <span class="mono" style="color:var(--text-faint)">FIPS ' + esc(lead.fips) + "</span></span></div>" +
          '<div class="row"><span class="k">Township</span><span class="v">' + esc(titleCase(lead.muni)) + "</span></div>" +
          '<div class="row"><span class="k">APN</span><span class="v m">' + esc(lead.apn) + "</span></div>" +
          '<div class="row"><span class="k">Acres</span><span class="v m">' + esc(acres) + "</span></div>" +
          '<div class="row"><span class="k">Land use</span><span class="v">' + esc(lead.use) + "</span></div>" +
          '<div class="row"><span class="k">Zoning</span><span class="v">' +
            (lead.zoning === "CALL" ? '<span class="badge alert">Call the township</span>' : esc(lead.zoning || "—")) + "</span></div>" +
          '<div class="row"><span class="k">School</span><span class="v">' + esc(lead.school) + "</span></div>" +
          (parcel.flood_zone ? '<div class="row"><span class="k">Flood zone</span><span class="v">' + esc(parcel.flood_zone) + "</span></div>" : "") +
          (parcel.land_locked !== undefined ? '<div class="row"><span class="k">Access</span><span class="v">' +
            (parcel.land_locked ? '<span class="badge alert">Land locked</span>' : "Not land locked") + "</span></div>" : "") +
          (parcel.tax_amount !== undefined ? '<div class="row"><span class="k">Tax / yr</span><span class="v m">' + esc(usd(parcel.tax_amount)) + "</span></div>" : "") +
        "</div>" +
        (terr.length ? '<div class="terrain">' + terr.map(function (t) {
          return '<div class="tr"><span class="k">' + esc(t[0]) + '</span><span class="bar"><i class="' +
            (t[3] ? "warn" : "") + '" style="width:' + Math.max(2, Math.min(100, t[1])).toFixed(0) +
            '%"></i></span><span class="n">' + esc(t[2]) + "</span></div>";
        }).join("") + "</div>" : "") +
        '<div class="locator">' + locator(lead, parcel) + "</div>" +
        (lead.link ? '<a class="portal-link" href="' + esc(lead.link) + '" target="_blank" rel="noopener noreferrer">Open parcel in Land Portal <span class="arrow">&rarr;</span></a>' : "") +
      "</div>" +

    "</div>" +

    notesBlock();
  }

  /* The same write-up block under a card and under an unrecognised number:
     a call worth taking is a call worth logging either way. */
  function notesBlock(lede) {
    return '<div class="notes">' +
      '<div class="notefield">' +
        '<label for="callnotes">Call notes</label>' +
        '<textarea id="callnotes" placeholder="Counter price, timeline, heirs, access…"></textarea>' +
        '<div class="notehint" id="notehint">' +
          esc(lede || "Write it up while it is fresh — hanging up leaves the card here.") +
        "</div>" +
      "</div>" +
      '<div class="disp"><span class="cap">Outcome</span><div class="btns" id="dispbtns">' +
        OUTCOMES.map(function (o) {
          return '<button class="dbtn" type="button">' + esc(o) + "</button>";
        }).join("") +
      "</div></div>" +
      '<button class="act pri" id="savenote" type="button">Save to log</button>' +
    "</div>" +
    '<div class="history" id="history"></div>';
  }

  /* ---------- screens ---------- */

  function cardKey(lead, kind, number) {
    return kind + "|" + (number || "") + "|" + ((lead && lead.ref) || "");
  }

  function showCard(lead, phone, parcel, kind, number) {
    var key = cardKey(lead, kind, number);
    if (cardState && cardState.key === key) readCard();   // same call, redrawn
    else cardState = {
      key: key, logId: null, secs: 0, notes: "", outcome: "",
      phase: kind === "call" ? "ringing" : "open"
    };
    stage.innerHTML = card(lead, phone, parcel, kind, number);
    wireCard(lead, number);
    restoreCard();
    loadHistory(lead.ref);
  }

  /* Pull what has been typed out of the card before its markup is thrown away. */
  function readCard() {
    var notes = document.getElementById("callnotes");
    if (notes) cardState.notes = notes.value;
    var disp = document.getElementById("dispbtns");
    if (disp) {
      var on = disp.querySelector(".dbtn.on");
      cardState.outcome = on ? on.textContent : "";
    }
  }

  function restoreCard() {
    var notes = document.getElementById("callnotes");
    if (notes) notes.value = cardState.notes || "";
    var disp = document.getElementById("dispbtns");
    if (disp && cardState.outcome) {
      Array.prototype.forEach.call(disp.children, function (b) {
        b.classList.toggle("on", b.textContent === cardState.outcome);
      });
    }
    if (cardState.logId) {
      var save = document.getElementById("savenote");
      if (save) save.textContent = "Add to log";
      hint("Already in the log. Anything else you learn is added to the same entry.", "saved");
    }
    paintPhase();
  }

  function hint(text, tone) {
    var el = document.getElementById("notehint");
    if (!el) return;
    el.textContent = text;
    el.className = "notehint" + (tone ? " " + tone : "");
  }

  var STRANGER = { ref: "", owner: "", greet: "", phones: [], offer: null,
                   pAddr: "", pCity: "", pState: "" };

  function showNoMatch(number) {
    var key = cardKey(STRANGER, "call", number);
    if (cardState && cardState.key === key) readCard();
    else cardState = { key: key, logId: null, secs: 0, notes: "", outcome: "",
                       phase: "ringing" };

    stage.innerHTML =
      '<div class="strip" id="strip"><span class="lamp"></span>' +
        '<span class="strip-state" id="stripstate">Incoming call</span>' +
        '<span class="strip-num">' + esc(fmtPhone(number)) + "</span>" +
        '<span class="strip-via">via Quo · (866) 520-9045</span>' +
        '<span class="strip-timer" id="timer">00:00</span>' +
        '<span class="strip-acts">' +
          '<button class="act pri" id="answer" type="button">Answer</button>' +
          '<button class="act end" id="hangup" type="button">Hang up</button>' +
        "</span></div>" +
      '<div class="nomatch"><h3>No mailer match</h3>' +
      "<p><span class=\"mono\">" + esc(fmtPhone(number)) + "</span> is not in any loaded mailer file, " +
      "on the primary number or any alternate. Ask for the reference on their letter.</p>" +
      '<form class="reffind" id="nmref">' +
        '<input id="nmrefinput" placeholder="Reference, name, address or APN" aria-label="Look up a record" autocomplete="off">' +
        '<button class="act pri" type="submit">Look up</button></form></div>' +
      // No record to attach it to, so the log keeps the number and the note.
      notesBlock("Nobody you mailed — the log still keeps the number and whatever they told you.");

    wireInlineSearch();
    wireCard(STRANGER, number);
    restoreCard();
  }

  function showPicker(hits, q) {
    stage.innerHTML =
      '<div class="strip answered"><span class="lamp"></span>' +
      '<span class="strip-state">' + hits.length + " matches</span>" +
      '<span class="strip-num">' + esc(q) + "</span></div>" +
      '<div class="picker"><h3>Which one?</h3>' +
      hits.map(function (h, i) {
        var l = h.lead;
        return '<button class="hit" type="button" data-i="' + i + '">' +
          '<span class="r">' + esc(l.ref) + "</span>" +
          '<span class="n">' + esc(titleCase(l.greet || l.owner)) + "</span>" +
          '<span class="a">' + esc([l.pAddr, l.pCity, l.pState].filter(Boolean).join(", ")) + "</span>" +
          '<span class="a">' + esc(l.source || "") + "</span></button>";
      }).join("") + "</div>";
    document.querySelector(".picker").addEventListener("click", function (e) {
      var b = e.target.closest(".hit");
      if (!b) return;
      var h = hits[+b.dataset.i];
      mode = "manual";
      showCard(h.lead, null, h.parcel, "manual");
      api("/api/show", { q: h.lead.ref }).then(function (r) {
        if (r.parcel) showCard(r.lead, null, r.parcel, "manual");
      }).catch(function () {});
    });
  }

  function showIdle(state) {
    mode = "idle";
    cardState = null;
    if (timer) { clearInterval(timer); timer = null; }
    var files = (state && state.files) || [];
    var records = (state && state.records) || 0;
    var reachable = (state && state.reachable) || 0;
    var ready = state && state.status === "listening";

    stage.innerHTML =
      '<div class="strip answered" style="border-top-color:' + (ready ? "var(--good)" : "var(--text-faint)") + '">' +
        '<span class="lamp" style="animation:none;background:' + (ready ? "var(--good)" : "var(--text-faint)") + '"></span>' +
        '<span class="strip-state" style="color:' + (ready ? "var(--good)" : "var(--text-faint)") + '">' +
          (ready ? "Listening" : "Not listening") + "</span>" +
        '<span class="strip-num">(866) 520-9045</span>' +
        '<span class="strip-via">' + esc(ready ? "Quo · waiting for a call" : (state && state.detail) || "relay not configured") + "</span></div>" +
      '<div class="nomatch"><h3>' + (records ? "Ready" : "No mailer files") + "</h3>" +
      "<p>" + (records
        ? records + " records across " + files.length + (files.length === 1 ? " mailer file" : " mailer files") +
          ", " + reachable + " of them reachable by phone. A caller's card appears here on its own."
        : "Drop your mailer CSV exports into the <span class=\"mono\">desk/mailers</span> folder, then click Reload.") + "</p>" +
      '<form class="reffind" id="nmref">' +
        '<input id="nmrefinput" placeholder="Reference, name, address or APN" aria-label="Look up a record" autocomplete="off">' +
        '<button class="act pri" type="submit">Look up</button></form></div>';
    wireInlineSearch();
  }

  function wireInlineSearch() {
    var f = document.getElementById("nmref");
    if (!f) return;
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      find(document.getElementById("nmrefinput").value);
    });
  }

  /* ---------- card behaviour ---------- */

  function clearCall(force) {
    // Clearing is the one way a written-but-unsaved note is lost, so it asks.
    var notes = document.getElementById("callnotes");
    if (!force && notes && notes.value.trim() &&
        !window.confirm("Clear this call? The notes have not been saved to the log.")) return;
    if (timer) { clearInterval(timer); timer = null; }
    cardState = null;
    api("/api/clear", {}).then(function (s) { seq = null; showIdle(s); }).catch(function () {});
  }

  /* ---------- the call strip ---------- */

  function paintTimer() {
    var el = document.getElementById("timer");
    if (el && cardState) {
      el.textContent = String(Math.floor(cardState.secs / 60)).padStart(2, "0") + ":" +
        String(cardState.secs % 60).padStart(2, "0");
    }
  }

  function startTimer() {
    if (timer) clearInterval(timer);
    paintTimer();
    timer = setInterval(function () {
      if (!cardState) return;
      cardState.secs++;
      paintTimer();
    }, 1000);
  }

  /* Draw the strip for whichever part of the call we are in. Also runs after a
     redraw, so answering a call and then having Land Portal answer does not
     put the card back to ringing. */
  function paintPhase() {
    var strip = document.getElementById("strip");
    if (!strip || !cardState) return;
    var state = document.getElementById("stripstate");
    var acts = strip.querySelector(".strip-acts");

    if (cardState.phase === "live") {
      strip.classList.add("answered");
      if (state) state.textContent = "On the call";
      var answer = document.getElementById("answer");
      if (answer) answer.remove();
      startTimer();
    } else if (cardState.phase === "wrap") {
      strip.classList.remove("answered");
      strip.classList.add("wrapup");
      if (state) state.textContent = "Call ended — write it up";
      if (acts) {
        acts.innerHTML = '<button class="act" id="clearbtn" type="button">Clear</button>';
        acts.querySelector("#clearbtn").addEventListener("click", function () { clearCall(); });
      }
      paintTimer();
    }
  }

  /* Hanging up used to wipe the screen, which meant writing the call up was
     something you had to remember to do first. The card stays put instead. */
  function endCall() {
    if (timer) { clearInterval(timer); timer = null; }
    if (!cardState) return;
    cardState.phase = "wrap";
    paintPhase();
    var notes = document.getElementById("callnotes");
    if (notes) {
      notes.focus();
      if (!cardState.logId) {
        hint("They have hung up — the card waits here until you clear it.", "");
      }
    }
  }

  function wireCard(lead, number) {
    var answer = document.getElementById("answer");
    var hangup = document.getElementById("hangup");
    var clear = document.getElementById("clearbtn");

    if (answer) answer.addEventListener("click", function () {
      cardState.phase = "live";
      paintPhase();
    });

    if (hangup) hangup.addEventListener("click", endCall);
    if (clear) clear.addEventListener("click", function () { clearCall(); });

    var disp = document.getElementById("dispbtns");
    if (disp) disp.addEventListener("click", function (e) {
      var b = e.target.closest(".dbtn");
      if (!b) return;
      var was = b.classList.contains("on");
      Array.prototype.forEach.call(disp.children, function (c) { c.classList.remove("on"); });
      if (!was) b.classList.add("on");
    });

    /* The first save writes the row; every save after it adds to that same
       row, so the deed that turns up on Thursday lands under Tuesday's call
       instead of starting a second one. */
    var save = document.getElementById("savenote");
    if (save) save.addEventListener("click", function () {
      var notes = document.getElementById("callnotes");
      var text = notes ? notes.value.trim() : "";
      var chosen = disp && disp.querySelector(".dbtn.on");
      var outcome = chosen ? chosen.textContent : "";

      if (!text && !outcome) {
        hint(cardState.logId ? "Nothing new to add yet."
                             : "Write a note or pick an outcome first.", "failed");
        if (notes) notes.focus();
        return;
      }

      var adding = !!cardState.logId;
      save.disabled = true;
      api("/api/note", {
        id: cardState.logId || "",
        number: number || ((lead.phones || [])[0] || {}).num || "",
        ref: lead.ref,
        owner: lead.owner,
        parcel: [lead.pAddr, lead.pCity, lead.pState].filter(Boolean).join(", "),
        offer: lead.offer,
        outcome: outcome,
        notes: text
      }).then(function (r) {
        save.disabled = false;

        /* A reply without an entry means the desk did not write what this
           page thinks it wrote, so the note must stay in the box: it is the
           only copy. Reading r.entry.id regardless is how this used to fail,
           as "Cannot read properties of undefined (reading 'id')" in the hint
           line -- which named the one thing nobody needed to know, and lost
           the note behind it if the save was retried. */
        var entry = r && r.entry;
        if (!entry || !entry.id) {
          report("error", "save returned no entry", {
            adding: adding, ref: lead.ref || "", reply: r, ui: UI_VERSION
          });
          hint(stale ? staleMessage()
                     : "The desk did not confirm the save. Your note is still " +
                       "here — check desk/logs/calldesk.log.", "failed");
          return;
        }

        save.textContent = "Add to log";
        cardState.logId = entry.id;
        cardState.notes = "";
        if (notes) notes.value = "";
        hint((adding ? "Added at " : "Saved to the log at ") +
             shortTime(entry.updated || entry.when) +
             (lead.ref ? " — it is below, and anything else goes in the same entry."
                       : " — it is under Call log, and anything else goes in the same entry."),
             "saved");
        loadHistory(lead.ref);
        loadLogCount();
      }).catch(function (err) {
        save.disabled = false;
        hint(stale ? staleMessage() : (err.message || "Could not write the log."),
             "failed");
      });
    });
  }

  /* ---------- the log ---------- */

  function shortDate(stamp) {
    return String(stamp || "").replace(/:\d{2}$/, "");
  }

  function shortTime(stamp) {
    var m = /\d{4}-\d{2}-\d{2} (\d{2}:\d{2})/.exec(String(stamp || ""));
    return m ? m[1] : String(stamp || "");
  }

  /* A note keeps the time it was written in front of it, so an entry reads
     top to bottom as the call and then everything that came in afterwards. */
  function noteLine(line, i, when) {
    var m = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(line);
    if (m) return '<p><span class="at">' + esc(shortTime(m[1])) + "</span>" + esc(m[2]) + "</p>";
    return "<p>" + (i === 0 ? '<span class="at">' + esc(shortTime(when)) + "</span>" : "") +
      esc(line) + "</p>";
  }

  function entryHtml(e) {
    var lines = String(e.notes || "").split("\n").filter(function (l) { return l.trim(); });
    var offer = e.offer === "" || e.offer === undefined ? null : Number(e.offer);
    var meta = [e.parcel, offer ? "offered " + usd0(offer) : ""].filter(Boolean).join(" · ");

    return '<div class="lg-entry" data-id="' + esc(e.id) + '">' +
      '<div class="lg-head">' +
        '<span class="lg-when">' + esc(e.when) + "</span>" +
        (e.outcome ? '<span class="badge ' + (OUTCOME_TONE[e.outcome] || "") + '">' +
          esc(e.outcome) + "</span>" : "") +
        '<span class="lg-who">' + esc(titleCase(e.owner) || "—") + "</span>" +
        (e.reference ? '<span class="lg-ref">' + esc(e.reference) + "</span>" : "") +
        (e.number ? '<span class="lg-num">' + esc(fmtPhone(e.number)) + "</span>" : "") +
        '<button class="act lg-add" type="button">Add detail</button>' +
      "</div>" +
      (meta ? '<div class="lg-parcel">' + esc(meta) + "</div>" : "") +
      (lines.length
        ? '<div class="lg-notes">' + lines.map(function (l, i) {
            return noteLine(l, i, e.when);
          }).join("") + "</div>"
        : '<div class="lg-notes empty">No notes on this one.</div>') +
      (e.updated ? '<div class="lg-upd">Last added ' + esc(shortDate(e.updated)) + "</div>" : "") +
      '<form class="lg-more" hidden>' +
        '<textarea placeholder="What came up since the call? Filed under its own timestamp."></textarea>' +
        '<div class="lg-moreacts">' +
          '<button class="act pri" type="submit">Add to log</button>' +
          '<span class="msg"></span>' +
        "</div>" +
      "</form>" +
    "</div>";
  }

  /* One click handler for a list of entries, wherever it is drawn: under the
     card for this record, or in the Call log panel for all of them. */
  function wireLogList(root, reload) {
    root.reloadLog = reload;
    if (root.logWired) return;
    root.logWired = true;

    root.addEventListener("click", function (e) {
      var add = e.target.closest(".lg-add");
      if (!add) return;
      var form = add.closest(".lg-entry").querySelector(".lg-more");
      form.hidden = !form.hidden;
      add.textContent = form.hidden ? "Add detail" : "Cancel";
      if (!form.hidden) form.querySelector("textarea").focus();
    });

    root.addEventListener("submit", function (e) {
      var form = e.target.closest(".lg-more");
      if (!form) return;
      e.preventDefault();
      var entry = form.closest(".lg-entry");
      var box = form.querySelector("textarea");
      var msg = form.querySelector(".msg");
      var text = box.value.trim();
      if (!text) { msg.textContent = "Write something first."; box.focus(); return; }
      var btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      msg.textContent = "";
      api("/api/note", { id: entry.dataset.id, notes: text })
        .then(function (r) {
          // Same rule as the card: what is in the box is the only copy of it
          // until the desk says it has the text.
          if (!r || !r.entry || !r.entry.id) {
            btn.disabled = false;
            report("error", "add-detail returned no entry",
                   { id: entry.dataset.id, reply: r, ui: UI_VERSION });
            msg.textContent = stale ? staleMessage() : "The desk did not confirm it.";
            return;
          }
          // Close the box before redrawing: a filled one holds the redraw off.
          box.value = "";
          form.hidden = true;
          var add = entry.querySelector(".lg-add");
          if (add) add.textContent = "Add detail";
          root.reloadLog();
        })
        .catch(function (err) {
          btn.disabled = false;
          msg.textContent = stale ? staleMessage()
                                  : (err.message || "Could not write the log.");
        });
    });
  }

  function loadHistory(ref) {
    var box = document.getElementById("history");
    if (!box || !ref) return;
    if (openDetail(box)) return;
    api("/api/log?limit=6&ref=" + encodeURIComponent(ref)).then(function (r) {
      box = document.getElementById("history");
      if (!box) return;                       // the card moved on while we asked
      var rows = r.entries || [];
      if (!rows.length) { box.innerHTML = ""; return; }
      box.innerHTML =
        '<div class="hcap">This record in the call log' +
          '<span class="n">' + r.total + (r.total === 1 ? " call" : " calls") +
          (rows.length < r.total ? ", latest " + rows.length : "") + "</span></div>" +
        '<div class="loglist">' + rows.map(entryHtml).join("") + "</div>";
      wireLogList(box, function () { loadHistory(ref); });
    }).catch(function () {});
  }

  /* True while an Add detail box is open with something in it. */
  function openDetail(root) {
    return Array.prototype.some.call(root.querySelectorAll(".lg-more"), function (f) {
      return !f.hidden && f.querySelector("textarea").value.trim();
    });
  }

  function loadLogCount() {
    api("/api/log?limit=1").then(function (r) {
      document.getElementById("log-count").textContent =
        r.total ? r.total + (r.total === 1 ? " call" : " calls") : "empty";
    }).catch(function () {});
  }

  /* ---------- lookup ---------- */

  function find(q) {
    q = String(q || "").trim();
    if (!q) return;
    api("/api/search?q=" + encodeURIComponent(q)).then(function (r) {
      var hits = r.hits || [];
      if (hits.length === 1) {
        mode = "manual";
        showCard(hits[0].lead, null, hits[0].parcel, "manual");
        api("/api/show", { q: hits[0].lead.ref }).then(function (res) {
          if (res.parcel && mode === "manual") showCard(res.lead, null, res.parcel, "manual");
        }).catch(function () {});
      } else if (hits.length > 1) {
        mode = "picker";
        showPicker(hits, q);
      } else {
        mode = "manual";
        stage.innerHTML =
          '<div class="strip answered"><span class="lamp" style="background:var(--text-faint);animation:none"></span>' +
          '<span class="strip-state" style="color:var(--text-faint)">No match</span></div>' +
          '<div class="nomatch"><h3>Nothing matches that</h3>' +
          '<p>No record for <span class="mono">' + esc(q) + '</span> in any loaded mailer file. ' +
          'References look like <span class="mono">V001-150</span>.</p>' +
          '<form class="reffind" id="nmref"><input id="nmrefinput" placeholder="Reference, name, address or APN" aria-label="Look up a record" autocomplete="off">' +
          '<button class="act pri" type="submit">Look up</button></form></div>';
        wireInlineSearch();
      }
    }).catch(function () {});
  }

  /* ---------- live state ---------- */

  function paintHeader(s) {
    checkVersion(s.version);
    var dot = document.getElementById("line-dot");
    var text = document.getElementById("line-text");
    var map = {
      listening: ["", "Quo line listening"],
      starting: ["off", "Connecting…"],
      error: ["off", s.detail || "Relay unreachable"],
      off: ["off", "Manual lookup only"]
    };
    var m = map[s.status] || map.off;
    dot.className = "dot " + m[0];
    // A relay running on memory only pops the card when the call and the poll
    // happen to reach the same copy of the function. Say so rather than let it
    // look like an intermittent fault.
    var onMemory = s.status === "listening" && /^memory/.test(s.store || "");
    text.textContent = onMemory ? "Listening \u2014 add Redis, cards will be missed" : m[1];
    if (onMemory) dot.className = "dot off";
    document.getElementById("rec-count").textContent =
      s.files.length + (s.files.length === 1 ? " file" : " files") + " · " + s.records + " records";

    document.getElementById("filelist").innerHTML = s.files.length
      ? s.files.map(function (f) {
          return '<div class="frow"><span class="nm">' + esc(f.name) + "</span>" +
            '<span class="ct">' + (f.error ? esc(f.error) : f.records + " records · " + f.reachable + " with a number") +
            "</span></div>";
        }).join("")
      : '<div class="frow"><span class="nm">No CSV files in desk/mailers yet</span></div>';
  }

  /* The desk answers with the version of the Python that is running. An old
     one predates this field entirely, which is itself the answer. */
  function checkVersion(version) {
    var bad = version !== UI_VERSION;
    var banner = document.getElementById("stale");
    if (banner) {
      banner.hidden = !bad;
      if (bad) banner.textContent = staleMessage();
    }
    if (bad && !stale) {
      report("error", "desk is running an older version", {
        desk: version || "(older than versions)", ui: UI_VERSION
      });
    }
    stale = bad;
  }

  function tick() {
    api("/api/state").then(function (s) {
      paintHeader(s);
      var call = s.call;
      if (!call) {
        if (mode === "call") { mode = "idle"; showIdle(s); }
        else if (mode === "idle") showIdle(s);
        return;
      }
      if (call.seq === seq) return;   // already on screen
      seq = call.seq;
      mode = "call";
      if (call.matched && call.card) {
        showCard(call.card.lead, call.card.phone, call.card.parcel, "call", call.number);
      } else {
        showNoMatch(call.number);
      }
    }).catch(function () {
      document.getElementById("line-text").textContent = "Call Desk stopped";
      document.getElementById("line-dot").className = "dot off";
    });
  }

  /* ---------- chrome ---------- */

  document.getElementById("themebtn").addEventListener("click", function () {
    var r = document.documentElement;
    var cur = r.getAttribute("data-theme") ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    r.setAttribute("data-theme", cur === "dark" ? "light" : "dark");
  });

  var filesPanel = document.getElementById("filespanel");
  var testPanel = document.getElementById("testpanel");
  var logPanel = document.getElementById("logpanel");
  var logList = document.getElementById("loglist");
  var logFilter = document.getElementById("logfilter");
  var logDebounce = null;

  function drawLog() {
    var query = logFilter.value.trim();
    return api("/api/log?limit=120&q=" + encodeURIComponent(query)).then(function (r) {
      var rows = r.entries || [];
      logList.innerHTML = rows.length
        ? rows.map(entryHtml).join("")
        : '<div class="lg-empty">' + (query
            ? "Nothing in the log matches <b>" + esc(query) + "</b>."
            : "No calls saved yet. Hang up on the first one, write down what happened, " +
              "and it lands here.") + "</div>";
      loadLogCount();
    }).catch(function () {
      logList.innerHTML = '<div class="lg-empty">Could not read the log.</div>';
    });
  }

  wireLogList(logList, drawLog);
  document.getElementById("logbtn").addEventListener("click", function () {
    logPanel.hidden = !logPanel.hidden;
    if (!logPanel.hidden) drawLog();
  });
  document.getElementById("logreload").addEventListener("click", drawLog);
  logFilter.addEventListener("input", function () {
    clearTimeout(logDebounce);
    logDebounce = setTimeout(drawLog, 140);
  });

  document.getElementById("filesbtn").addEventListener("click", function () {
    filesPanel.hidden = !filesPanel.hidden;
  });
  document.getElementById("testbtn").addEventListener("click", function () {
    testPanel.hidden = !testPanel.hidden;
  });
  document.getElementById("reloadbtn").addEventListener("click", function () {
    api("/api/reload").then(function (s) { paintHeader(s); if (mode === "idle") showIdle(s); });
  });
  document.getElementById("testring").addEventListener("click", function () {
    api("/api/ring", { number: document.getElementById("testnum").value }).then(function () {
      seq = null;
      tick();
    });
  });
  /* ---------- type-ahead ----------
     The list is the primary way in: matching runs on the desk, so it can be
     generous about how an address is typed -- "653 cr", "county road 653" and
     "45341 County Rd 653" all reach the same parcel. */
  var box = document.getElementById("refnum");
  var panel = document.getElementById("suggest");
  var hits = [];
  var cursor = -1;
  var debounce = null;
  var lastQuery = "";

  function closeSuggest() {
    panel.hidden = true;
    panel.innerHTML = "";
    box.setAttribute("aria-expanded", "false");
    hits = [];
    cursor = -1;
  }

  function highlight() {
    Array.prototype.forEach.call(panel.children, function (el, i) {
      el.classList.toggle("on", i === cursor);
      if (i === cursor && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    });
  }

  function pick(i) {
    var hit = hits[i];
    if (!hit) return;
    box.value = hit.ref;
    closeSuggest();
    find(hit.ref);
  }

  function drawSuggest(rows, query) {
    hits = rows;
    cursor = -1;
    if (!rows.length) {
      panel.innerHTML = '<div class="sg-empty">Nothing matches <b>' + esc(query) + "</b></div>";
      panel.hidden = false;
      box.setAttribute("aria-expanded", "true");
      return;
    }
    panel.innerHTML = rows.map(function (h, i) {
      var meta = [];
      if (h.acres) meta.push(h.acres + " ac");
      if (h.offer) meta.push("offered " + usd0(h.offer));
      return '<button class="sg" type="button" role="option" data-i="' + i + '">' +
        '<span class="r">' + esc(h.ref) + "</span>" +
        '<span class="n">' + esc(titleCase(h.name)) + "</span>" +
        '<span class="ph">' + (h.phone ? esc(fmtPhone(h.phone)) : "no number") + "</span>" +
        '<span class="a">' + esc(h.parcel || "\u2014") + "</span>" +
        (meta.length ? '<span class="meta">' + esc(meta.join("  \u00b7  ")) + "</span>" : "") +
        "</button>";
    }).join("");
    panel.hidden = false;
    box.setAttribute("aria-expanded", "true");
  }

  function askSuggest() {
    var query = box.value.trim();
    if (query.length < 2) { closeSuggest(); lastQuery = ""; return; }
    if (query === lastQuery) return;
    lastQuery = query;
    api("/api/suggest?q=" + encodeURIComponent(query))
      .then(function (r) {
        if (box.value.trim() !== query) return;   // a later keystroke won
        drawSuggest(r.hits || [], query);
      })
      .catch(function () { closeSuggest(); });
  }

  box.addEventListener("input", function () {
    clearTimeout(debounce);
    debounce = setTimeout(askSuggest, 110);
  });

  box.addEventListener("keydown", function (e) {
    var open = !panel.hidden && hits.length;
    if (e.key === "ArrowDown" && open) {
      e.preventDefault();
      cursor = (cursor + 1) % hits.length;
      highlight();
    } else if (e.key === "ArrowUp" && open) {
      e.preventDefault();
      cursor = cursor <= 0 ? hits.length - 1 : cursor - 1;
      highlight();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && cursor >= 0) pick(cursor);
      else { closeSuggest(); find(this.value); }
    } else if (e.key === "Escape" && !panel.hidden) {
      e.stopPropagation();          // close the list, do not clear the call
      closeSuggest();
    }
  });

  panel.addEventListener("mousedown", function (e) {
    var b = e.target.closest(".sg");
    if (!b) return;
    e.preventDefault();             // keep focus off the blur handler
    pick(+b.dataset.i);
  });

  box.addEventListener("blur", function () { setTimeout(closeSuggest, 120); });
  box.addEventListener("focus", function () { lastQuery = ""; askSuggest(); });

  document.getElementById("findbtn").addEventListener("click", function () {
    closeSuggest();
    find(box.value);
  });

  document.addEventListener("keydown", function (e) {
    var typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName || "");
    if (e.key === "/" && !typing) {
      e.preventDefault();
      var box = document.getElementById("refnum");
      box.focus();
      box.select();
    } else if (e.key === "Escape") {
      if (typing) {
        e.target.blur();
        // Escape out of a note box means "stop typing", never "throw it away".
        if (e.target.id === "callnotes" || e.target.closest(".lg-more")) return;
      }
      box.value = "";
      closeSuggest();
      clearCall();
    }
  });

  tick();
  loadLogCount();
  setInterval(tick, POLL_MS);
})();
