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
    return fetch(path, opts).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
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
            '<button class="act end" id="hangup" type="button">Clear</button>' +
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

    '<div class="notes">' +
      '<div style="flex:1;min-width:240px;display:flex;flex-direction:column;gap:5px">' +
        '<label for="callnotes" style="font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--text-faint);font-weight:600">Call notes</label>' +
        '<textarea id="callnotes" placeholder="Counter price, timeline, heirs, access…"></textarea>' +
      "</div>" +
      '<div class="disp"><span class="cap">Outcome</span><div class="btns" id="dispbtns">' +
        '<button class="dbtn" type="button">Accepted</button>' +
        '<button class="dbtn" type="button">Countered</button>' +
        '<button class="dbtn" type="button">Thinking</button>' +
        '<button class="dbtn" type="button">Not selling</button>' +
        '<button class="dbtn" type="button">Wrong number</button>' +
        '<button class="dbtn" type="button">Remove from list</button>' +
      "</div></div>" +
      '<button class="act pri" id="savenote" type="button">Save to log</button>' +
    "</div>";
  }

  /* ---------- screens ---------- */

  function showCard(lead, phone, parcel, kind, number) {
    stage.innerHTML = card(lead, phone, parcel, kind, number);
    wireCard(lead, number);
  }

  function showNoMatch(number) {
    stage.innerHTML =
      '<div class="strip"><span class="lamp"></span>' +
        '<span class="strip-state">Incoming call</span>' +
        '<span class="strip-num">' + esc(fmtPhone(number)) + "</span>" +
        '<span class="strip-via">via Quo · (866) 520-9045</span>' +
        '<span class="strip-acts"><button class="act end" id="hangup" type="button">Clear</button></span></div>' +
      '<div class="nomatch"><h3>No mailer match</h3>' +
      "<p><span class=\"mono\">" + esc(fmtPhone(number)) + "</span> is not in any loaded mailer file, " +
      "on the primary number or any alternate. Ask for the reference on their letter.</p>" +
      '<form class="reffind" id="nmref">' +
        '<input id="nmrefinput" placeholder="Reference, name, address or APN" aria-label="Look up a record" autocomplete="off">' +
        '<button class="act pri" type="submit">Look up</button></form></div>';
    wireInlineSearch();
    var hangup = document.getElementById("hangup");
    if (hangup) hangup.addEventListener("click", clearCall);
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

  function clearCall() {
    api("/api/clear", {}).then(function (s) { seq = null; showIdle(s); }).catch(function () {});
  }

  function wireCard(lead, number) {
    var strip = document.getElementById("strip");
    var state = document.getElementById("stripstate");
    var timerEl = document.getElementById("timer");
    var answer = document.getElementById("answer");
    var hangup = document.getElementById("hangup");
    var secs = 0;

    if (answer) answer.addEventListener("click", function () {
      strip.classList.add("answered");
      state.textContent = "On the call";
      answer.remove();
      if (timer) clearInterval(timer);
      timer = setInterval(function () {
        secs++;
        if (timerEl) {
          timerEl.textContent = String(Math.floor(secs / 60)).padStart(2, "0") + ":" +
            String(secs % 60).padStart(2, "0");
        }
      }, 1000);
    });

    if (hangup) hangup.addEventListener("click", function () {
      if (timer) clearInterval(timer);
      clearCall();
    });

    var disp = document.getElementById("dispbtns");
    if (disp) disp.addEventListener("click", function (e) {
      var b = e.target.closest(".dbtn");
      if (!b) return;
      var was = b.classList.contains("on");
      Array.prototype.forEach.call(disp.children, function (c) { c.classList.remove("on"); });
      if (!was) b.classList.add("on");
    });

    var save = document.getElementById("savenote");
    if (save) save.addEventListener("click", function () {
      var chosen = disp && disp.querySelector(".dbtn.on");
      api("/api/note", {
        number: number || (lead.phones[0] && lead.phones[0].num) || "",
        ref: lead.ref,
        owner: lead.owner,
        parcel: [lead.pAddr, lead.pCity, lead.pState].filter(Boolean).join(", "),
        offer: lead.offer,
        outcome: chosen ? chosen.textContent : "",
        notes: (document.getElementById("callnotes") || {}).value || ""
      }).then(function () {
        save.textContent = "Saved";
        setTimeout(function () { save.textContent = "Save to log"; }, 1600);
      }).catch(function () {
        save.textContent = "Could not save";
      });
    });
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
    var ver = document.getElementById("version");
    if (s.version && ver.textContent.indexOf("v") === -1) {
      ver.textContent = "Hometown Land \u00b7 v" + s.version;
      ver.title = "Released " + (s.released || "");
    }
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
        '<span class="ph">' + (h.phone ? esc(fmtPhone(h.phone)) : "no number") +
          (h.line && h.line !== "Primary" ? ' <span style="color:var(--live)">' + esc(h.line) + "</span>" : "") +
          (h.dnc ? ' <span style="color:var(--alert)">DNC</span>' : "") + "</span>" +
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
      if (typing) e.target.blur();
      box.value = "";
      closeSuggest();
      clearCall();
    }
  });

  tick();
  setInterval(tick, POLL_MS);
})();
