/* Hometown Land — the /stats dashboard.
   Reads the counters and the visit log from /api/track for whatever period is
   picked, and draws them. Bots and the owner's own visits are left out by the
   server. The key is held in this browser only and sent as a header rather
   than in the URL, so it does not end up in a log or a shared link.

   The period lives in the address (#from=…&to=…) and every change of period
   is a history entry, so the browser's Back button walks back through what
   was looked at: last 7 days, then one day of it, then a 3-day stretch. */
(function () {
  "use strict";

  var gate = document.getElementById("keyGate");
  if (!gate) return;

  var KEY_STORE = "htl.statskey";
  var OWNER_STORE = "htl.owner";   /* read by site.js: this browser is the owner's */
  var EARLIEST = 399;              /* days back the server keeps */
  var PAGE = 50;                   /* visit rows drawn at a time */

  var $ = function (id) { return document.getElementById(id); };
  var dash = $("dash"), note = $("dashNote"), keyInput = $("keyInput"), keyMsg = $("keyMsg");
  var body = $("stBody"), chips = $("chips"), customForm = $("customForm");
  var fromDate = $("fromDate"), toDate = $("toDate"), filterInput = $("filterInput");

  var range = null;        /* { from, to } on screen */
  var latest = null;       /* the last report */
  var shown = PAGE;
  var pick = null;         /* a breakdown row clicked: { kind, value, label } */
  var asked = 0;           /* request counter, so a slow answer cannot overwrite a newer one */

  /* ------------------------------------------------------------ storage */

  function get(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }
  function put(k, v) {
    try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {}
  }

  /* -------------------------------------------------------------- dates
     Every day is an Eastern-time calendar day, as the server keeps them, and
     handled as a "YYYY-MM-DD" string so no browser timezone can move it. */

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July",
                     "August", "September", "October", "November", "December"];
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function today() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  }
  function parts(iso) { return iso.split("-").map(Number); }
  function addDays(iso, n) {
    var p = parts(iso);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
  }
  function span(from, to) {
    var a = parts(from), b = parts(to);
    return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000) + 1;
  }
  function weekday(iso, long) {
    var p = parts(iso);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
    return (long ? DAYS_LONG : DAYS)[d];
  }
  function short(iso) { var p = parts(iso); return MONTHS[p[1] - 1] + " " + p[2]; }
  function withYear(iso) { return short(iso) + ", " + parts(iso)[0]; }
  function monthStart(iso) { return iso.slice(0, 8) + "01"; }
  function monthEnd(iso) { return addDays(monthStart(addDays(monthStart(iso), 32)), -1); }
  function earliest() { return addDays(today(), -EARLIEST); }

  function clamp(r) {
    var t = today(), lo = earliest();
    var from = r.from, to = r.to;
    if (from > to) { var x = from; from = to; to = x; }
    if (to > t) to = t;
    if (from < lo) from = lo;
    if (from > to) from = to;
    return { from: from, to: to };
  }

  var PRESETS = {
    today: function (t) { return { from: t, to: t }; },
    yesterday: function (t) { var y = addDays(t, -1); return { from: y, to: y }; },
    "7": function (t) { return { from: addDays(t, -6), to: t }; },
    "30": function (t) { return { from: addDays(t, -29), to: t }; },
    "90": function (t) { return { from: addDays(t, -89), to: t }; },
    month: function (t) { return { from: monthStart(t), to: t }; },
    lastmonth: function (t) {
      var end = addDays(monthStart(t), -1);
      return { from: monthStart(end), to: end };
    }
  };
  var PRESET_NAMES = {
    today: "Today", yesterday: "Yesterday", "7": "Last 7 days", "30": "Last 30 days",
    "90": "Last 90 days", month: "This month", lastmonth: "Last month"
  };

  /* Which preset, if any, a range is. */
  function presetOf(r) {
    var t = today();
    for (var k in PRESETS) {
      var p = PRESETS[k](t);
      if (p.from === r.from && p.to === r.to) return k;
    }
    return "";
  }
  function isWholeMonth(r) {
    return r.from === monthStart(r.from) && monthStart(r.to) === r.from
      && (r.to === monthEnd(r.from) || r.to === today());
  }

  /* The title for a range, as a person would say it. */
  function titleOf(r) {
    var p = presetOf(r);
    if (p) return PRESET_NAMES[p];
    if (r.from === r.to) return weekday(r.from, true) + ", " + short(r.from);
    if (isWholeMonth(r)) return MONTHS_LONG[parts(r.from)[1] - 1] + " " + parts(r.from)[0];
    return short(r.from) + " – " + short(r.to);
  }
  function subOf(r) {
    if (r.from === r.to) return weekday(r.from, true) + ", " + withYear(r.from);
    return withYear(r.from) + " – " + withYear(r.to) + " · " + span(r.from, r.to) + " days";
  }

  /* ------------------------------------------------------------ helpers */

  function num(n) { return (n || 0).toLocaleString("en-US"); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  var STATES = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
    CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
    FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana",
    IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
    MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
    MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
    NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
    OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
    SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
    VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin",
    WY: "Wyoming", PR: "Puerto Rico"
  };

  /* "Sanford, NC" at home, "Toronto, ON, CA" abroad. */
  function place(v) {
    var bits = [v.city, v.region];
    if (v.country && v.country !== "US") bits.push(v.country);
    return bits.filter(Boolean).join(", ");
  }
  /* The counters name a city "Sanford, NC, US" and a state "US-NC". */
  function cityName(raw) { return String(raw).replace(/, US$/, ""); }
  function stateName(raw) {
    var m = /^US-([A-Z]{2})$/.exec(raw);
    return m ? (STATES[m[1]] || m[1]) : raw;
  }

  /* ------------------------------------------------------------ the period */

  function hashOf(r) { return "#from=" + r.from + "&to=" + r.to; }
  function fromHash() {
    var q = new URLSearchParams(location.hash.slice(1));
    var from = q.get("from"), to = q.get("to"), p = q.get("p");
    if (p && PRESETS[p]) return PRESETS[p](today());
    if (/^\d{4}-\d{2}-\d{2}$/.test(from || "") && /^\d{4}-\d{2}-\d{2}$/.test(to || "")) {
      return clamp({ from: from, to: to });
    }
    return PRESETS["7"](today());
  }

  /* Go to a period: a new history entry that remembers where we came from,
     so "← Back to Last 7 days" can say where Back goes. */
  function go(r) {
    r = clamp(r);
    if (range && r.from === range.from && r.to === range.to) { customForm.hidden = true; return; }
    var depth = (history.state && history.state.depth) || 0;
    history.pushState({ depth: depth + 1, back: range ? titleOf(range) : "" }, "",
      location.pathname + hashOf(r));
    show(r);
  }

  function show(r) {
    range = r;
    pick = null;
    filterInput.value = "";
    shown = PAGE;
    customForm.hidden = true;
    drawHead();
    load();
  }

  function drawHead() {
    $("periodTitle").textContent = titleOf(range);
    $("periodSub").textContent = subOf(range);
    var st = history.state || {};
    var back = $("backBtn");
    back.hidden = !(st.depth && st.back);
    back.textContent = "← Back to " + (st.back || "");

    $("prevBtn").disabled = range.from <= earliest();
    $("nextBtn").disabled = range.to >= today();

    var p = presetOf(range);
    Array.prototype.forEach.call(chips.querySelectorAll("button"), function (b) {
      var on = b.getAttribute("data-p") === (p || "custom");
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    fromDate.value = range.from;
    toDate.value = range.to;
    fromDate.min = toDate.min = earliest();
    fromDate.max = toDate.max = today();
  }

  /* ‹ and ›: the same length of time before or after. A whole month steps by
     calendar month, so "October" goes to "September", not 31 days earlier. */
  function step(dir) {
    if (isWholeMonth(range)) {
      var start = dir < 0 ? monthStart(addDays(range.from, -1)) : addDays(monthEnd(range.from), 1);
      return go({ from: start, to: monthEnd(start) });
    }
    var n = span(range.from, range.to);
    go({ from: addDays(range.from, dir * n), to: addDays(range.to, dir * n) });
  }

  /* ---------------------------------------------------------------- data */

  function say(text) {
    note.textContent = text || "";
    note.hidden = !text;
  }

  function askForKey(rejected) {
    dash.hidden = true;
    gate.hidden = false;
    keyMsg.classList.toggle("on", !!rejected);
    keyInput.value = "";
    keyInput.focus();
  }

  function load() {
    var key = get(KEY_STORE);
    if (!key) return askForKey(false);

    var mine = ++asked;
    body.classList.add("busy");
    fetch("/api/track?from=" + range.from + "&to=" + range.to, {
      headers: { "x-traffic-key": key },
      cache: "no-store"
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (b) {
          return { status: r.status, body: b };
        });
      })
      .then(function (res) {
        if (mine !== asked) return;
        body.classList.remove("busy");
        if (res.status === 401) { put(KEY_STORE, ""); return askForKey(true); }
        if (res.status === 503) {
          dash.hidden = true;
          gate.hidden = true;
          return say("Traffic recording is not switched on yet: set TRAFFIC_KEY in the "
                   + "Vercel project settings and redeploy.");
        }
        if (!res.body || !res.body.ok) {
          return say("The dashboard could not read the numbers: "
                   + ((res.body && res.body.error) || "HTTP " + res.status) + ".");
        }
        if (res.body.store === "none") {
          dash.hidden = true;
          gate.hidden = true;
          return say(res.body.note);
        }
        /* A key that works means this is the owner's browser. */
        put(OWNER_STORE, "1");
        say("");
        gate.hidden = true;
        dash.hidden = false;
        latest = res.body;
        render();
      })
      .catch(function () {
        if (mine !== asked) return;
        body.classList.remove("busy");
        say("Could not reach /api/track. Check the connection and try again.");
      });
  }

  /* -------------------------------------------------------------- render */

  function render() {
    var d = latest;
    var t = d.totals;
    var f = d.funnel || { starts: 0, submits: 0 };

    var tiles = $("tiles");
    tiles.textContent = "";
    [
      ["Visits", num(t.visits), "people, once per visit"],
      ["Page views", num(t.views), t.visits ? (t.views / t.visits).toFixed(1) + " pages per visit" : "—"],
      ["Offer requests", num(t.leads), t.visits ? ((t.leads / t.visits) * 100).toFixed(1) + "% of visits" : "—"],
      ["Form started", num(f.starts), f.starts ? num(f.submits) + " of them sent it" : "nobody yet"]
    ].forEach(function (x) {
      var tile = el("div", "st-tile");
      tile.appendChild(el("div", "st-tile-n", x[1]));
      tile.appendChild(el("div", "st-tile-l", x[0]));
      tile.appendChild(el("div", "st-tile-s", x[2]));
      tiles.appendChild(tile);
    });

    if (range.from === range.to) drawHours(); else drawDays();
    drawVisits();
    drawBreakdowns();
    drawFoot();
  }

  /* ---- the chart: a bar per day. Click a bar for that day; drag across
     bars for the days in between. */

  function drawBars(items, labelOf, tipOf) {
    var chart = $("chart");
    chart.textContent = "";
    var peak = items.reduce(function (m, x) { return Math.max(m, x.n); }, 0) || 1;
    items.forEach(function (x) {
      var col = el("div", "st-col");
      col.title = tipOf(x);
      var bar = el("span", "st-bar");
      bar.style.height = x.n ? Math.max(3, Math.round((x.n / peak) * 100)) + "%" : "0";
      if (x.n) bar.appendChild(el("em", null, num(x.n)));
      col.appendChild(bar);
      chart.appendChild(col);
    });
    chart.classList.toggle("dense", items.length > 31);

    var axis = $("axis");
    axis.textContent = "";
    /* A label every so often, so they never collide. */
    var every = Math.max(1, Math.ceil(items.length / 8));
    items.forEach(function (x, i) {
      axis.appendChild(el("span", null, i % every === 0 ? labelOf(x) : ""));
    });
  }

  function drawDays() {
    $("chartHead").textContent = "Visits per day";
    $("chartHint").textContent = "Click a day to open it, or drag across days for a range";
    drawBars((latest.daily || []).map(function (x) {
      return { n: x.visits, date: x.date, views: x.views, leads: x.leads };
    }), function (x) { return short(x.date); }, function (x) {
      return weekday(x.date, true) + ", " + short(x.date) + ": " + num(x.n) + " visits, "
        + num(x.views) + " page views" + (x.leads ? ", " + num(x.leads) + " offer requests" : "");
    });
    $("chart").classList.add("pickable");
  }

  /* One day: visits by the hour they started, from the visit log. */
  function drawHours() {
    var hours = [];
    for (var h = 0; h < 24; h++) hours.push({ n: 0, h: h });
    (latest.visits || []).forEach(function (v) {
      var m = /^(\d+):\d+\s*(AM|PM)$/i.exec(v.time || "");
      if (m) hours[Number(m[1]) % 12 + (/pm/i.test(m[2]) ? 12 : 0)].n++;
    });
    function hourName(h) { return (h % 12 || 12) + (h < 12 ? "am" : "pm"); }
    $("chartHead").textContent = "Visits by hour (Eastern)";
    $("chartHint").textContent = latest.visits && latest.visits.length ? ""
      : "Hour by hour comes from the visit log, which has nothing for this day.";
    drawBars(hours, function (x) { return hourName(x.h); },
      function (x) { return hourName(x.h) + "–" + hourName((x.h + 1) % 24) + ": " + num(x.n) + " visits"; });
    $("chart").classList.remove("pickable");
  }

  /* Pointer events cover mouse, pen and touch alike. A press and release on
     the same bar is a click; anything wider is a range. */
  (function () {
    var chart = $("chart");
    var anchor = -1, over = -1;
    function indexAt(x) {
      var cols = chart.children;
      if (!cols.length) return -1;
      var box = chart.getBoundingClientRect();
      var i = Math.floor(((x - box.left) / box.width) * cols.length);
      return Math.max(0, Math.min(cols.length - 1, i));
    }
    function mark() {
      var lo = Math.min(anchor, over), hi = Math.max(anchor, over);
      Array.prototype.forEach.call(chart.children, function (c, i) {
        c.classList.toggle("sel", anchor >= 0 && i >= lo && i <= hi);
      });
    }
    function reset() { anchor = over = -1; mark(); }
    chart.addEventListener("pointerdown", function (e) {
      if (!chart.classList.contains("pickable") || e.button > 0) return;
      anchor = over = indexAt(e.clientX);
      try { chart.setPointerCapture(e.pointerId); } catch (x) {}
      mark();
    });
    chart.addEventListener("pointermove", function (e) {
      if (anchor < 0) return;
      over = indexAt(e.clientX);
      mark();
    });
    chart.addEventListener("pointerup", function () {
      if (anchor < 0) return;
      var days = latest.daily || [];
      var a = days[Math.min(anchor, over)], b = days[Math.max(anchor, over)];
      reset();
      if (a && b) go({ from: a.date, to: b.date });
    });
    chart.addEventListener("pointercancel", reset);
  })();

  /* ---- the visit log */

  function matches(v) {
    if (pick) {
      if (pick.kind === "city" && place(v) !== pick.value) return false;
      if (pick.kind === "state" && !(v.country === "US" && v.region === pick.value)) return false;
      if (pick.kind === "country" && v.country !== pick.value) return false;
      if (pick.kind === "source" && v.source !== pick.value) return false;
      if (pick.kind === "page" && v.pages.indexOf(pick.value) === -1) return false;
      if (pick.kind === "device" && v.device !== pick.value) return false;
    }
    var q = filterInput.value.trim().toLowerCase();
    if (!q) return true;
    var hay = [place(v), STATES[v.region] || "", v.source, v.campaign, v.device, v.form,
               v.pages.join(" ")].join(" ").toLowerCase();
    return q.split(/\s+/).every(function (w) { return hay.indexOf(w) !== -1; });
  }

  function visible() { return (latest.visits || []).filter(matches); }

  function drawVisits() {
    var box = $("visitLog");
    box.textContent = "";
    var all = latest.visits || [];
    var rows = visible();
    var oneDay = range.from === range.to;
    var filtered = rows.length !== all.length;
    $("visitsHead").textContent = "Visits"
      + (all.length ? " (" + num(rows.length) + (filtered ? " of " + num(all.length) : "") + ")" : "");
    $("csvBtn").disabled = !rows.length;

    var chip = $("filterChip");
    chip.textContent = "";
    chip.hidden = !pick;
    if (pick) {
      chip.appendChild(el("span", null, pick.label));
      var x = el("button", null, "×");
      x.type = "button";
      x.setAttribute("aria-label", "Clear this filter");
      x.addEventListener("click", function () { pick = null; shown = PAGE; drawVisits(); });
      chip.appendChild(x);
    }

    if (!rows.length) {
      var why;
      if (all.length) why = "No visits match the filter.";
      else if (!latest.logStart || range.to < latest.logStart) {
        why = latest.logStart
          ? "Visit-by-visit records begin on " + withYear(latest.logStart)
            + ". For earlier days the totals, chart and lists still apply."
          : "No visits have been recorded one by one yet.";
      } else why = "Nobody visited in this period.";
      box.appendChild(el("p", "st-empty", why));
      return;
    }
    if (latest.logStart && range.from < latest.logStart) {
      box.appendChild(el("p", "st-empty st-empty-s", "Visit-by-visit records begin on "
        + withYear(latest.logStart) + "; days before that appear in the totals only."));
    }

    var wrap = el("div", "st-tbl-wrap");
    var t = el("table", "st-tbl");
    var head = el("tr");
    [oneDay ? "Time" : "When", "Location", "Came from", "Pages", "Device"]
      .forEach(function (h) { head.appendChild(el("th", null, h)); });
    var thead = el("thead");
    thead.appendChild(head);
    t.appendChild(thead);
    var tb = el("tbody");
    rows.slice(0, shown).forEach(function (v) {
      var tr = el("tr");
      var when = el("td", "c-when");
      if (oneDay) {
        when.textContent = v.time;
      } else {
        when.appendChild(el("span", null, weekday(v.date) + " " + short(v.date)));
        when.appendChild(el("small", null, v.time));
      }
      tr.appendChild(when);
      tr.appendChild(el("td", "c-loc", place(v) || "Unknown"));
      tr.appendChild(el("td", null, (v.source || "—") + (v.campaign ? " · " + v.campaign : "")));

      var pg = el("td", "c-pages");
      var top = el("div");
      top.appendChild(document.createTextNode(v.pages.length + (v.pages.length === 1 ? " page" : " pages")));
      if (v.form) {
        top.appendChild(el("span", "st-tag" + (v.form === "Sent" ? " st-tag-lead" : ""),
          v.form === "Sent" ? "Sent an offer request" : "Form: " + v.form.toLowerCase()));
      }
      pg.appendChild(top);
      pg.appendChild(el("small", null, v.pages.join(" → ")));
      tr.appendChild(pg);
      tr.appendChild(el("td", "c-dev", v.device || "—"));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    wrap.appendChild(t);
    box.appendChild(wrap);

    if (rows.length > shown) {
      var more = el("button", "backlink st-more", "Show more (" + num(rows.length - shown) + " not shown)");
      more.type = "button";
      more.addEventListener("click", function () { shown += 500; drawVisits(); });
      box.appendChild(more);
    }
    if (latest.visitCount > all.length) {
      box.appendChild(el("p", "st-empty st-empty-s", "Only the newest " + num(all.length) + " of "
        + num(latest.visitCount) + " visits fit in one view. Pick a shorter period for the rest."));
    }
  }

  /* ---- the lists above the log. Clicking a row filters the log by it. */

  function breakdown(title, one, rows, kind, nameOf, valueOf) {
    var card = el("div", "st-card st-list");
    card.appendChild(el("h3", null, title));
    if (!rows || !rows.length) {
      card.appendChild(el("p", "st-empty", "Nothing in this period."));
      return card;
    }
    var top = rows.reduce(function (m, r) { return Math.max(m, r.count); }, 0) || 1;
    var list = el("ol");
    rows.slice(0, 10).forEach(function (r) {
      var li = el("li");
      var b = el("button");
      b.type = "button";
      var name = nameOf ? nameOf(r.name) : r.name;
      b.title = "Show only these visits";
      b.appendChild(el("span", "n", name));
      b.appendChild(el("span", "c", num(r.count)));
      var fill = el("i");
      fill.style.width = Math.max(2, Math.round((r.count / top) * 100)) + "%";
      b.appendChild(fill);
      b.addEventListener("click", function () {
        pick = { kind: kind, value: valueOf ? valueOf(r.name) : r.name, label: one + ": " + name };
        shown = PAGE;
        drawVisits();
        $("visitsHead").scrollIntoView({ behavior: "smooth", block: "start" });
      });
      li.appendChild(b);
      list.appendChild(li);
    });
    card.appendChild(list);
    return card;
  }

  function drawBreakdowns() {
    var d = latest;
    var grid = $("breakdowns");
    grid.textContent = "";
    grid.appendChild(breakdown("Towns", "Town", d.cities, "city", cityName, cityName));
    grid.appendChild(breakdown("States", "State",
      (d.regions || []).filter(function (r) { return /^US-/.test(r.name); }),
      "state", stateName, function (n) { return n.slice(3); }));
    grid.appendChild(breakdown("Where they came from", "Came from", d.sources, "source"));
    grid.appendChild(breakdown("Pages read", "Page", d.pages, "page"));
    grid.appendChild(breakdown("Devices", "Device", d.devices, "device"));
    grid.appendChild(breakdown("Countries", "Country", d.countries, "country"));
  }

  function drawFoot() {
    var d = latest;
    var bots = (d.bots && d.bots.visits) || 0;
    var me = (d.owner && d.owner.hidden && d.owner.hidden.visits) || 0;
    var towns = (d.owner && d.owner.towns) || [];
    $("excluded").textContent = "Left out of everything above: " + num(bots)
      + (bots === 1 ? " bot visit" : " bot visits") + " and " + num(me)
      + (me === 1 ? " visit of your own." : " visits of your own.");
    $("ownerNote").textContent = "This browser is marked as yours, so your own reading of the "
      + "site is never counted. Open this page once on your phone to mark it too."
      + (towns.length ? " Visits from " + towns.join(" or ") + " count as yours on any device." : "");
    $("dashFoot").textContent = "Times are Eastern. A visit is one browser tab's stay on the site. "
      + "Location comes from the connection's network, so it is right to the town at best and "
      + "wrong for anyone on a VPN. A visit counts as a bot when its browser, location or "
      + "behaviour gives it away: known crawlers, scripted browsers, data-center towns such as "
      + "Ashburn VA, and anyone who left in under a second without touching the page. Visitors "
      + "who ask not to be tracked are not counted.";
  }

  /* ------------------------------------------------------------- exports */

  function download(name, lines) {
    /* The byte-order mark makes Excel read the file as UTF-8, so "–" and
       "→" survive. */
    var blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function cell(v) {
    var s = v === undefined || v === null ? "" : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function stamp() {
    return range.from === range.to ? range.from : range.from + "-to-" + range.to;
  }

  /* Every visit in the period that passes the filter, oldest first. */
  function exportVisits() {
    if (!latest) return;
    var lines = [["Date", "Time (Eastern)", "Day", "Town", "State", "Country", "Came from",
                  "Campaign", "Landing page", "Pages viewed", "Pages in order", "Device",
                  "Offer form"].join(",")];
    visible().slice().reverse().forEach(function (v) {
      lines.push([v.date, v.time, weekday(v.date, true), v.city, v.region, v.country, v.source,
                  v.campaign, v.pages[0], v.pages.length, v.pages.join(" > "), v.device,
                  v.form].map(cell).join(","));
    });
    download("hometownland-visits-" + stamp() + ".csv", lines);
  }

  function exportDaily() {
    if (!latest) return;
    var lines = ["Date,Day,Visits,Page views,Offer requests"];
    (latest.daily || []).forEach(function (d) {
      lines.push([d.date, weekday(d.date, true), d.visits, d.views, d.leads].join(","));
    });
    download("hometownland-daily-" + stamp() + ".csv", lines);
  }

  /* -------------------------------------------------------------- wiring */

  gate.addEventListener("submit", function (e) {
    e.preventDefault();
    var k = keyInput.value.trim();
    if (!k) return;
    put(KEY_STORE, k);
    gate.hidden = true;
    load();
  });

  chips.addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    var p = b.getAttribute("data-p");
    if (p === "custom") {
      customForm.hidden = !customForm.hidden;
      if (!customForm.hidden) fromDate.focus();
      return;
    }
    go(PRESETS[p](today()));
  });
  customForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (fromDate.value && toDate.value) go({ from: fromDate.value, to: toDate.value });
  });
  $("prevBtn").addEventListener("click", function () { step(-1); });
  $("nextBtn").addEventListener("click", function () { step(1); });
  $("backBtn").addEventListener("click", function () { history.back(); });
  addEventListener("popstate", function () { show(fromHash()); });

  var typing;
  filterInput.addEventListener("input", function () {
    clearTimeout(typing);
    typing = setTimeout(function () { shown = PAGE; if (latest) drawVisits(); }, 150);
  });
  $("csvBtn").addEventListener("click", exportVisits);
  $("dailyCsvBtn").addEventListener("click", exportDaily);
  $("forgetBtn").addEventListener("click", function () {
    put(KEY_STORE, "");
    say("");
    askForKey(false);
  });

  /* ?key=… works once, for the first visit from a saved link, and is taken
     out of the address bar at once so it is not left in history or copied on. */
  var fromUrl = new URLSearchParams(location.search).get("key");
  if (fromUrl) put(KEY_STORE, fromUrl.trim());
  var start = fromHash();
  history.replaceState({ depth: 0, back: "" }, "", location.pathname + hashOf(start));
  show(start);
})();
