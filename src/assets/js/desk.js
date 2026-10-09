/* Hometown Land — the phone Call Desk (/desk).

   The cloud copy of the laptop desk. The laptop sends its mailer records to
   /api/desk whenever it starts or reloads its folder; this page downloads
   them once, keeps them in memory only (never in this phone's storage), and
   searches them here, so typing stays instant on a weak signal.

   Every few seconds while the page is open it asks whether a call is ringing
   and which calls came in lately, and opens the caller's card on its own.

   The desk key is the one thing kept in this browser. It goes in a header,
   never the URL, so it does not end up in a log or a shared link. */
(function () {
  "use strict";

  var KEY_STORE = "htl.deskkey";
  var POLL_MS = 4000;

  var $ = function (id) { return document.getElementById(id); };
  var gate = $("gate"), app = $("app"), status = $("status");

  var state = {
    gen: "", meta: null, leads: [], index: [], byRef: {}, byPhone: {},
    recent: [], ringing: null, seenCall: "", texting: false, loading: false,
    // Opened from a link in a text: that card is what was asked for, so a call
    // already ringing when the page opens does not take its place.
    keepLink: !!location.hash,
  };

  /* ------------------------------------------------------------ helpers */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ten(raw) {
    var d = String(raw || "").replace(/\D/g, "");
    if (d.length === 11 && d.charAt(0) === "1") d = d.slice(1);
    return d.length === 10 ? d : "";
  }
  function fmtPhone(raw) {
    var d = ten(raw);
    return d ? "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6) : String(raw || "");
  }
  function n(v) { return v === null || v === undefined || v === "" || !isFinite(Number(v)) ? null : Number(v); }
  function usd(v) { return n(v) === null ? "—" : "$" + Math.round(v).toLocaleString("en-US"); }
  function pct(a, b) { return n(a) !== null && n(b) ? Math.round(a / b * 100) + "%" : ""; }
  function refKey(r) { return String(r || "").toUpperCase().replace(/\s+/g, ""); }
  function titleCase(s) {
    s = String(s || "");
    // Only shout-cased names get folded; "McDonald" typed properly stays.
    if (s !== s.toUpperCase()) return s;
    return s.toLowerCase().replace(/\b([a-z])/g, function (m) { return m.toUpperCase(); });
  }
  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "";
    var today = new Date().toDateString() === d.toDateString();
    var t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return today ? t : d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + t;
  }

  function remembered() {
    try { return localStorage.getItem(KEY_STORE) || ""; } catch (e) { return ""; }
  }
  function remember(k) {
    try { k ? localStorage.setItem(KEY_STORE, k) : localStorage.removeItem(KEY_STORE); } catch (e) {}
  }

  var toastTimer = 0;
  function toast(text) {
    var t = $("toast");
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  /* ---------------------------------------------------------------- api */

  function api(op, opts) {
    opts = opts || {};
    var url = "/api/desk?op=" + op + (opts.query || "");
    return fetch(url, {
      method: opts.body ? "POST" : "GET",
      headers: Object.assign(
        { "x-desk-key": remembered() },
        opts.body ? { "Content-Type": "application/json" } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401) { var e = new Error("bad key"); e.auth = true; throw e; }
        if (r.status === 409) { var s = new Error("resynced"); s.resynced = true; throw s; }
        if (!r.ok || !data.ok) throw new Error(data.error || "HTTP " + r.status);
        return data;
      });
    });
  }

  /* ------------------------------------------------------------- search */

  // The same folding the laptop desk does (calldesk.py), so "22 s main st"
  // finds "22 South Main Street" and "653 cr" finds "County Road 653".
  var PHRASES = [["county road", "cr"], ["county rd", "cr"], ["state highway", "hwy"],
    ["state route", "hwy"], ["post office box", "po box"]];
  var WORDS = {
    north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw",
    southeast: "se", southwest: "sw", street: "st", avenue: "ave", av: "ave", road: "rd",
    drive: "dr", lane: "ln", court: "ct", circle: "cir", boulevard: "blvd", highway: "hwy",
    place: "pl", terrace: "ter", parkway: "pkwy", trail: "trl", route: "rt", square: "sq",
    point: "pt", township: "twp", county: "co", saint: "st", mount: "mt", apartment: "apt",
    suite: "ste", unit: "apt"
  };
  var WEIGHTS = [["parcel", 6], ["owner", 4], ["ref", 5], ["mail", 2], ["apn", 3]];

  function normalize(text) {
    var low = " " + String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
    PHRASES.forEach(function (p) { low = low.split(" " + p[0] + " ").join(" " + p[1] + " "); });
    return low.split(" ").filter(Boolean).map(function (t) { return WORDS[t] || t; });
  }

  function entry(lead) {
    return {
      lead: lead,
      f: {
        parcel: normalize([lead.pAddr, lead.pCity, lead.pState, lead.pZip, lead.pCounty].join(" ")),
        owner: normalize((lead.owner || "") + " " + (lead.greet || "")),
        ref: normalize(lead.ref),
        mail: normalize([lead.mAddr, lead.mCity, lead.mState, lead.mZip].join(" ")),
        apn: normalize(lead.apn)
      },
      digits: (lead.phones || []).map(function (p) { return String(p.num || ""); }),
      apnDigits: String(lead.apn || "").replace(/\D/g, "")
    };
  }

  function termScore(e, term) {
    var best = 0;
    WEIGHTS.forEach(function (w) {
      e.f[w[0]].forEach(function (tok, pos) {
        var hit;
        if (tok === term) hit = w[1] * 2;
        else if (tok.indexOf(term) === 0) hit = w[1] * 1.4;
        else if (term.length >= 4 && tok.indexOf(term) !== -1) hit = w[1] * 0.8;
        else return;
        best = Math.max(best, hit + Math.max(0, 1.5 - pos * 0.15));
      });
    });
    return best;
  }

  function phoneScore(e, q) {
    var best = 0;
    e.digits.forEach(function (d) {
      if (!d) return;
      if (d === q) best = Math.max(best, 120);
      else if (d.indexOf(q) === 0) best = Math.max(best, 95);
      else if (d.slice(-q.length) === q) best = Math.max(best, 90);
      else if (d.indexOf(q) !== -1) best = Math.max(best, 70);
    });
    return best;
  }

  function rank(query, limit) {
    var raw = String(query || "").trim();
    if (!raw) return [];
    var exact = state.byRef[refKey(raw)];
    if (exact) return [exact];

    var digits = raw.replace(/\D/g, "");
    if (digits.length === 11 && digits.charAt(0) === "1") digits = digits.slice(1);
    var qd = digits.length >= 3 && !/[a-z]/i.test(raw) ? digits : "";
    var terms = qd ? [] : normalize(raw);
    if (!qd && !terms.length) return [];

    var scored = [];
    state.index.forEach(function (e) {
      var v = 0;
      if (qd) {
        var street = e.f.parcel.indexOf(qd) !== -1 ? (e.f.parcel[0] === qd ? 92 : 88) : 0;
        v = Math.max(phoneScore(e, qd), street, termScore(e, qd), e.apnDigits.indexOf(qd) !== -1 ? 40 : 0);
      } else {
        for (var i = 0; i < terms.length; i++) {
          var hit = termScore(e, terms[i]);
          if (!hit) { v = 0; break; }       // every word has to land somewhere
          v += hit;
        }
      }
      if (v) scored.push([v, e.lead]);
    });
    scored.sort(function (a, b) { return b[0] - a[0]; });
    return scored.slice(0, limit || 30).map(function (p) { return p[1]; });
  }

  /* --------------------------------------------------------------- data */

  function loadAll(meta) {
    if (state.loading) return Promise.resolve();
    state.loading = true;
    var parts = [];
    for (var p = 0; p < meta.parts; p++) {
      parts.push(api("part", { query: "&gen=" + encodeURIComponent(meta.synced.gen) + "&p=" + p }));
    }
    status.textContent = "Loading " + meta.synced.records + " records…";
    return Promise.all(parts).then(function (pages) {
      var leads = [];
      pages.forEach(function (pg) {
        pg.leads.forEach(function (lead, k) {
          if (!lead) return;
          lead._i = pg.first + k;
          leads.push(lead);
        });
      });
      var byRef = {}, byPhone = {};
      // Oldest campaign first, so a re-mailed owner lands on the newest letter.
      leads.forEach(function (lead) {
        if (lead.ref) byRef[refKey(lead.ref)] = lead;
        (lead.phones || []).forEach(function (ph) { if (ph.num) byPhone[ph.num] = lead; });
      });
      state.gen = meta.synced.gen;
      state.leads = leads;
      state.index = leads.map(entry);
      state.byRef = byRef;
      state.byPhone = byPhone;
    }).finally(function () { state.loading = false; });
  }

  function syncLine() {
    var m = state.meta && state.meta.synced;
    if (!m) return "Nothing synced yet — start the Call Desk on the laptop once and it sends its mailer files here.";
    return m.records + " records from " + m.files.length + (m.files.length === 1 ? " file" : " files") +
      ", synced from the laptop " + when(m.at) + "." +
      (state.texting ? "" : " Texts to your cell are off — QUO_API_KEY and CALL_TEXT_TO are not set.");
  }

  function paintStatus() {
    var m = state.meta && state.meta.synced;
    status.textContent = m ? m.records + " records · synced " + when(m.at) : "No records synced yet";
    $("syncline").textContent = syncLine();
  }

  /* -------------------------------------------------------------- poll */

  var pollTimer = 0;
  function poll() {
    clearTimeout(pollTimer);
    return api("meta").then(function (meta) {
      state.meta = meta;
      state.recent = meta.recent || [];
      state.texting = !!meta.texting;
      var work = Promise.resolve();
      if (meta.synced && meta.synced.gen !== state.gen) work = loadAll(meta);
      if (!meta.synced) {
        state.gen = ""; state.leads = []; state.index = []; state.byRef = {}; state.byPhone = {};
      }
      return work.then(function () {
        if (!meta.ringing) state.keepLink = false;
        paintStatus();
        paintRinging(meta.ringing);
        if (!location.hash) paintRecent();
        route(false);
      });
    }).catch(function (err) {
      if (err.auth) return askForKey(true);
      if (err.resynced) { state.gen = ""; return; }
      status.textContent = "Offline — " + err.message;
    }).finally(function () {
      if (!gate.hidden) return;
      pollTimer = setTimeout(poll, document.hidden ? POLL_MS * 4 : POLL_MS);
    });
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && remembered()) poll();
  });

  /* ---------------------------------------------------------- screens */

  function paintRinging(ringing) {
    var banner = $("ringing");
    state.ringing = ringing;
    if (!ringing) { banner.hidden = true; return; }
    var lead = state.byPhone[ringing.caller];
    banner.textContent = "Ringing now · " + fmtPhone(ringing.caller) +
      (lead ? " · " + titleCase(lead.greet || lead.owner) : " · no mailer match");
    banner.href = "#p=" + ringing.caller;
    banner.hidden = false;
    // A new call opens its card on its own, the way the laptop desk does.
    var id = ringing.callId || ringing.caller + ringing.at;
    if (state.keepLink) { state.keepLink = false; state.seenCall = id; }
    if (id !== state.seenCall) {
      state.seenCall = id;
      if (location.hash !== "#p=" + ringing.caller) location.hash = "p=" + ringing.caller;
    }
  }

  function item(lead, right, sub, href) {
    return '<a class="item" href="' + esc(href) + '"><div class="t"><span>' + esc(titleCase(lead.greet || lead.owner) || lead.ref) +
      "</span><span>" + esc(right) + '</span></div><div class="s">' + esc(sub) + "</div></a>";
  }

  function leadHref(lead) { return lead.ref ? "#r=" + encodeURIComponent(lead.ref) : "#i=" + lead._i; }

  function paintRecent() {
    var box = $("recent");
    if (!state.recent.length) {
      box.innerHTML = '<p class="empty">No calls yet. When your Quo line rings, the caller shows up here and opens on its own.</p>';
      return;
    }
    box.innerHTML = state.recent.map(function (c) {
      var lead = state.byPhone[c.caller];
      var to = c.line ? " · to " + c.line.slice(0, 3) + " line" : "";
      var sub = fmtPhone(c.caller) + " · " + when(c.at) + to;
      if (lead) return item(lead, lead.ref || "", sub, "#p=" + c.caller);
      return '<a class="item none" href="#p=' + esc(c.caller) + '"><div class="t"><span>' + esc(fmtPhone(c.caller)) +
        '</span><span>no match</span></div><div class="s">' + esc(when(c.at) + to) + "</div></a>";
    }).join("");
  }

  function paintResults(q) {
    var box = $("results");
    if (!q.trim()) { box.hidden = true; return; }
    var hits = rank(q, 30);
    box.hidden = false;
    box.innerHTML = hits.length ? hits.map(function (lead) {
      var where = [lead.pAddr, lead.pCity, lead.pState].filter(Boolean).join(", ");
      var acres = lead.calcAcres || lead.acres;
      return item(lead, lead.ref || "",
        [where, acres ? acres + " ac" : "", lead.offer ? usd(lead.offer) : ""].filter(Boolean).join(" · "),
        leadHref(lead));
    }).join("") : '<p class="empty">' + (state.leads.length ? "No match." : "No records synced yet.") + "</p>";
  }

  /* ---------------------------------------------------------- the card */

  function market(lead) {
    var acres = n(lead.calcAcres) || n(lead.acres);
    var ppa = n(lead.realPPA) || (n(lead.retailFull) && acres ? lead.retailFull / acres : null);
    var value = n(lead.retailFull) || (ppa && acres ? ppa * acres : null);
    return { value: value, ppa: ppa, acres: acres };
  }

  function row(k, v, raw) {
    if (v === null || v === undefined || v === "") return "";
    return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v">' + (raw ? v : esc(v)) + "</span></div>";
  }

  function num(cls, k, v, s) {
    return '<div class="num ' + cls + '"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) +
      '</div><div class="s">' + esc(s || " ") + "</div></div>";
  }

  function telLink(d) { return '<a href="tel:+1' + esc(d) + '">' + esc(fmtPhone(d)) + "</a>"; }

  function card(lead, caller) {
    var m = market(lead);
    var parcel = lead.parcel || {};
    var phones = lead.phones || [];
    var line = caller ? phones.filter(function (p) { return p.num === caller; })[0] : null;
    var best = line || phones[0];
    var ringingNow = state.ringing && state.ringing.caller === caller;
    var parcelLine = [lead.pAddr, lead.pCity, [lead.pState, lead.pZip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    var mailLine = [lead.mAddr, lead.mCity, [lead.mState, lead.mZip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    var absentee = lead.mCity && lead.pCity && lead.mCity.toLowerCase() !== lead.pCity.toLowerCase();
    var maps = "https://maps.apple.com/?" + (n(lead.lat) !== null && n(lead.lon) !== null
      ? "ll=" + lead.lat + "," + lead.lon + "&q=" + encodeURIComponent(lead.ref || parcelLine)
      : "q=" + encodeURIComponent(parcelLine));

    var badges = '<span class="badge">Ref ' + esc(lead.ref || "—") + "</span>";
    if (lead.mailer) badges += '<span class="badge">Mailer #' + esc(lead.mailer) + "</span>";
    if (line) badges += '<span class="badge live">' + esc(line.label) + (line.type ? " · " + esc(line.type) : "") + "</span>";
    if (line && line.dnc) badges += '<span class="badge alert">DNC — they called you</span>';
    if (absentee) badges += '<span class="badge live">Absentee owner</span>';
    if (parcel.land_locked) badges += '<span class="badge alert">Land locked</span>';
    if (lead.zoning === "CALL") badges += '<span class="badge alert">Zoning: call the township</span>';

    var terrain = [];
    if (n(lead.build) !== null) terrain.push(row("Buildable", lead.build.toFixed(0) + "%" + (lead.build < 60 ? " ⚠" : "")));
    if (n(lead.slope) !== null) terrain.push(row("Avg slope", lead.slope.toFixed(1) + "%"));
    if (n(lead.wetlands) !== null) terrain.push(row("Wetlands", lead.wetlands.toFixed(1) + "%"));
    if (n(lead.flood) !== null) terrain.push(row("FEMA flood", lead.flood.toFixed(1) + "%"));

    var others = phones.filter(function (p) { return !best || p.num !== best.num; }).map(function (p) {
      return telLink(p.num) + ' <span class="sub">' + esc([p.label, p.type].filter(Boolean).join(" · ")) +
        (p.dnc ? ' · <span class="bad">DNC</span>' : "") + "</span>";
    });

    return '<button class="back" type="button" data-back>&larr; Back</button>' +
      '<div class="head">' +
        '<div class="state">' + (ringingNow ? "Ringing now · " + esc(fmtPhone(caller))
          : caller ? "Called from " + esc(fmtPhone(caller)) : "Mailer record") + "</div>" +
        '<div class="name">' + esc(titleCase(lead.greet || lead.owner) || "Unknown owner") + "</div>" +
        '<div class="sub">Deeded owner: ' + esc(titleCase(lead.owner) || "—") + "</div>" +
      "</div>" +
      '<div class="badges">' + badges + "</div>" +
      '<div class="acts">' +
        (best && !caller ? '<a class="pri" href="tel:+1' + esc(best.num) + '">Call ' + esc(fmtPhone(best.num)) + "</a>" : "") +
        '<button class="sec" type="button" data-text="' + lead._i + '">Text me this</button>' +
      "</div>" +

      '<div class="nums">' +
        num("offer", "Offer", usd(lead.offer),
          [lead.offerPPA ? usd(lead.offerPPA) + "/ac" : "", lead.ppaPct ? Math.round(lead.ppaPct * 100) + "% of mkt" : ""].filter(Boolean).join(" · ")) +
        num("", "Market value", usd(m.value), m.ppa ? usd(m.ppa) + "/ac" : "") +
        num("", "TLP estimate", usd(lead.tlp), lead.offer && lead.tlp ? "offer is " + pct(lead.offer, lead.tlp) : "") +
        num("", "Acres", m.acres === null ? "—" : String(m.acres), lead.calcAcres && lead.acres && lead.calcAcres !== lead.acres ? "deed " + lead.acres : "") +
        (n(lead.retail) ? num("", "Retail 90%", usd(lead.retail), "") : "") +
        (n(lead.profit) ? num("", "Projected profit", usd(lead.profit), "") : "") +
      "</div>" +

      '<div class="box"><h3>The parcel</h3>' +
        row("Address", parcelLine ? '<a href="' + esc(maps) + '">' + esc(parcelLine) + "</a>" : "", true) +
        row("County", lead.pCounty ? lead.pCounty + " County" + (lead.pState ? ", " + lead.pState : "") : "") +
        row("Township", titleCase(lead.muni)) +
        row("APN", lead.apn ? '<span class="mono">' + esc(lead.apn) + "</span>" : "", true) +
        row("Land use", lead.use) +
        row("Zoning", lead.zoning === "CALL" ? "Call the township" : lead.zoning) +
        row("Road frontage", n(lead.roadFt) !== null ? Math.round(lead.roadFt) + " ft" : "") +
        row("School", lead.school) +
        terrain.join("") +
        row("Flood zone", parcel.flood_zone) +
        row("Access", parcel.land_locked === undefined ? "" : parcel.land_locked ? '<span class="bad">Land locked</span>' : "Not land locked", true) +
        row("Tax / yr", n(parcel.tax_amount) !== null ? usd(parcel.tax_amount) : "") +
        row("Assessed", n(lead.assessed) ? usd(lead.assessed) : "") +
        row("County market", n(lead.market) ? usd(lead.market) : "") +
      "</div>" +

      '<div class="box"><h3>The owner</h3>' +
        row(caller ? "Calling from" : "Phone", caller ? telLink(caller) : best ? telLink(best.num) : "", true) +
        row("Other lines", others.join("<br>"), true) +
        row("Email", lead.email ? '<a href="mailto:' + esc(lead.email) + '">' + esc(lead.email) + "</a>" : "", true) +
        row("Mailing", mailLine + (lead.mCounty ? " (" + lead.mCounty + ")" : "")) +
        row("Offer sent", lead.offerDate) +
        row("Closes by", lead.closeDate) +
        row("From file", lead.source) +
      "</div>" +

      '<div class="links">' +
        (lead.link ? '<a class="sec" href="' + esc(lead.link) + '" target="_blank" rel="noopener noreferrer">Open in Land Portal &rarr;</a>' : "") +
        (parcelLine ? '<a class="sec" href="' + esc(maps) + '">Open in Maps</a>' : "") +
      "</div>";
  }

  function unknownCard(caller) {
    var ringingNow = state.ringing && state.ringing.caller === caller;
    return '<button class="back" type="button" data-back>&larr; Back</button>' +
      '<div class="head">' +
        '<div class="state miss">' + (ringingNow ? "Ringing now" : "Called") + " · no mailer match</div>" +
        '<div class="name">' + esc(fmtPhone(caller)) + "</div>" +
        '<div class="sub">This number is not in any synced mailer file. Ask for the reference on their letter and search for it above.</div>' +
      "</div>" +
      '<div class="acts"><a class="pri" href="tel:+1' + esc(caller) + '">Call back</a></div>';
  }

  function openCard(html) {
    $("home").hidden = true;
    $("results").hidden = true;
    var c = $("card");
    var changed = c.dataset.html !== html;
    if (changed) { c.innerHTML = html; c.dataset.html = html; }
    if (c.hidden || changed) { c.hidden = false; }
  }

  function closeCard() {
    var c = $("card");
    c.hidden = true;
    c.dataset.html = "";
    $("home").hidden = false;
    paintRecent();
    paintResults($("q").value);
  }

  /* #r=REF, #i=index, #p=phone. A text message links to #r=, so the card for
     the call you are on is one tap from the text. */
  var lastHash = null;
  function route(scroll) {
    var h = decodeURIComponent(location.hash.replace(/^#/, ""));
    var m = /^([rip])=(.+)$/.exec(h);
    if (!m) { if (lastHash !== "") closeCard(); lastHash = ""; return; }
    if (!state.leads.length && state.loading) return;

    var html;
    if (m[1] === "r") {
      var lead = state.byRef[refKey(m[2])];
      html = lead ? card(lead, "") : '<button class="back" type="button" data-back>&larr; Back</button>' +
        '<p class="empty">No record with reference ' + esc(m[2]) + (state.leads.length ? "." : " — nothing synced yet.") + "</p>";
    } else if (m[1] === "i") {
      var byIndex = state.leads.filter(function (l) { return String(l._i) === m[2]; })[0];
      html = byIndex ? card(byIndex, "") : '<button class="back" type="button" data-back>&larr; Back</button><p class="empty">That record is gone — the laptop re-synced.</p>';
    } else {
      var caller = ten(m[2]);
      var hit = state.byPhone[caller];
      html = hit ? card(hit, caller) : unknownCard(caller);
    }
    openCard(html);
    if (scroll !== false && lastHash !== h) window.scrollTo(0, 0);
    lastHash = h;
  }

  window.addEventListener("hashchange", function () { route(true); });

  /* --------------------------------------------------------- actions */

  document.addEventListener("click", function (ev) {
    var back = ev.target.closest("[data-back]");
    if (back) {
      if (history.length > 1 && lastHash) history.back();
      else location.hash = "";
      return;
    }
    var t = ev.target.closest("[data-text]");
    if (t) {
      t.disabled = true;
      t.textContent = "Sending…";
      api("text", { body: { gen: state.gen, index: Number(t.dataset.text) } }).then(function () {
        toast("Texted to your cell.");
        t.textContent = "Texted ✓";
      }).catch(function (err) {
        if (err.auth) return askForKey(true);
        toast(err.resynced ? "The records were re-synced — try again." : "Not sent: " + err.message);
        t.disabled = false;
        t.textContent = "Text me this";
      });
    }
  });

  var typing = 0;
  $("q").addEventListener("input", function () {
    clearTimeout(typing);
    var q = this.value;
    typing = setTimeout(function () {
      if (location.hash) { location.hash = ""; }
      paintResults(q);
    }, 120);
  });

  $("forget").addEventListener("click", function () {
    remember("");
    location.hash = "";
    askForKey(false);
  });

  $("refresh").addEventListener("click", function () { state.gen = ""; poll(); });

  /* ------------------------------------------------------------ gate */

  function askForKey(rejected) {
    clearTimeout(pollTimer);
    app.hidden = true;
    $("refresh").hidden = true;
    gate.hidden = false;
    $("keyErr").hidden = !rejected;
    status.textContent = "Locked";
    var input = $("keyInput");
    input.value = "";
    input.focus();
  }

  gate.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var k = $("keyInput").value.trim();
    if (!k) return;
    remember(k);
    start();
  });

  function start() {
    gate.hidden = true;
    app.hidden = false;
    $("refresh").hidden = false;
    poll();
  }

  if (remembered()) start(); else askForKey(false);
})();
