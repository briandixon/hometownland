/* Hometown Land — the /stats dashboard.
   Reads the counters and the visit log from /api/track and draws them. The key is held
   in this browser only; it is sent as a header rather than in the URL so it
   does not end up in a log or a shared link. */
(function () {
  "use strict";

  var gate = document.getElementById("keyGate");
  if (!gate) return;

  var KEY_STORE = "htl.statskey";
  var MINE_STORE = "htl.statsmine";
  var dash = document.getElementById("dash");
  var note = document.getElementById("dashNote");
  var keyInput = document.getElementById("keyInput");
  var keyMsg = document.getElementById("keyMsg");
  var rangeSel = document.getElementById("rangeSel");
  var fromDate = document.getElementById("fromDate");
  var toDate = document.getElementById("toDate");
  var dayBack = document.getElementById("dayBack");
  var dayBackBtn = document.getElementById("dayBackBtn");
  var botToggle = document.getElementById("botToggle");
  var mineToggle = document.getElementById("mineToggle");
  var latest = null;
  var shownVisits = 100;      /* rows of the visit log on screen; "Show more" adds to it */
  var before = null;          /* the range to go back to after looking at one day */

  /* ---- dates. Every day is an Eastern-time calendar day, as the server
     keeps them, and is handled as a "YYYY-MM-DD" string so no browser
     timezone can move it. */
  function todayET() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  }
  function addDays(iso, n) {
    var p = iso.split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
  }

  /* A preset from the "Showing" list as a from/to pair. */
  function presetRange(v) {
    var t = todayET();
    if (v === "today") return [t, t];
    if (v === "yesterday") return [addDays(t, -1), addDays(t, -1)];
    if (v === "month") return [t.slice(0, 8) + "01", t];
    if (v === "lastmonth") {
      var end = addDays(t.slice(0, 8) + "01", -1);
      return [end.slice(0, 8) + "01", end];
    }
    var n = Number(v) || 7;
    return [addDays(t, 1 - n), t];
  }

  function setRange(from, to) {
    fromDate.value = from;
    toDate.value = to;
  }

  function rangeLabel(from, to) {
    return from === to ? longDate(from) : longDate(from) + " – " + longDate(to);
  }

  function remembered() {
    try { return localStorage.getItem(KEY_STORE) || ""; } catch (e) { return ""; }
  }
  function remember(k) {
    try { k ? localStorage.setItem(KEY_STORE, k) : localStorage.removeItem(KEY_STORE); } catch (e) {}
  }

  /* Hiding the owner's own visits is the default; showing them is remembered. */
  function hideMine() {
    try { return localStorage.getItem(MINE_STORE) !== "show"; } catch (e) { return true; }
  }

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

  function num(n) { return (n || 0).toLocaleString("en-US"); }

  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  /* "2026-09-21" -> "Mon, Sep 21, 2026" */
  function longDate(iso) {
    var p = iso.split("-").map(Number);
    var dow = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
    return DAYS[dow] + ", " + shortDate(iso) + ", " + p[0];
  }

  /* "2026-09-21" -> "Sep 21". Split by hand: new Date("2026-09-21") is UTC
     midnight, which shows as the day before once it is rendered locally. */
  function shortDate(iso) {
    var p = iso.split("-");
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return months[Number(p[1]) - 1] + " " + Number(p[2]);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function tile(label, value, sub) {
    var t = el("div", "tile");
    t.appendChild(el("div", "tile-n", value));
    t.appendChild(el("div", "tile-l", label));
    if (sub) t.appendChild(el("div", "tile-s", sub));
    return t;
  }

  /* One table: name, a bar for its share, the count. */
  function panel(title, rows, empty) {
    var box = el("div", "panel");
    box.appendChild(el("h2", null, title));
    if (!rows || !rows.length) {
      box.appendChild(el("p", "note", empty));
      return box;
    }
    var top = rows.reduce(function (m, r) { return Math.max(m, r.count); }, 0) || 1;
    var list = el("div", "tbl");
    rows.forEach(function (r) {
      var row = el("div", "tr");
      row.appendChild(el("span", "td-n", r.name));
      var track = el("span", "td-b");
      var fill = el("i");
      fill.style.width = Math.max(2, Math.round((r.count / top) * 100)) + "%";
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el("span", "td-c", num(r.count)));
      list.appendChild(row);
    });
    box.appendChild(list);
    return box;
  }

  /* Each day is one bar: people's page views, their visits drawn inside it,
     and with "Show bots" on, the bots' page views stacked on top. */
  function drawChart(daily, withBots) {
    var chart = document.getElementById("chart");
    chart.textContent = "";
    function total(d) { return d.views + (withBots ? d.botViews || 0 : 0); }
    var peak = daily.reduce(function (m, d) { return Math.max(m, total(d)); }, 0) || 1;

    daily.forEach(function (d) {
      var col = el("div", "col");
      col.addEventListener("click", function () { openDay(d.date); });
      var all = total(d);
      col.title = shortDate(d.date) + ": " + num(d.views) + " views, "
                + num(d.visits) + " visits"
                + (d.leads ? ", " + num(d.leads) + " offer requests" : "")
                + (withBots ? "; bots: " + num(d.botViews) + " views" : "")
                + " — click to see this day";
      var bar = el("span", "bar");
      bar.style.height = Math.max(1, Math.round((all / peak) * 100)) + "%";
      var inner = el("i");
      inner.style.height = all ? Math.round((d.visits / all) * 100) + "%" : "0";
      bar.appendChild(inner);
      if (withBots && d.botViews) {
        var bots = el("b");
        bots.style.top = "0";
        bots.style.height = Math.round((d.botViews / all) * 100) + "%";
        bar.appendChild(bots);
      }
      col.appendChild(bar);
      chart.appendChild(col);
    });

    /* Only the ends get a label, otherwise 90 days of dates collide. */
    if (daily.length) {
      var ends = el("div", "chart-ends");
      ends.appendChild(el("span", null, shortDate(daily[0].date)));
      ends.appendChild(el("span", null, shortDate(daily[daily.length - 1].date)));
      chart.parentNode.insertBefore(ends, chart.nextSibling);
    }
  }

  /* The same days as the chart, as numbers, newest first. A row opens its day. */
  function drawDayTable(daily, withBots) {
    var box = document.getElementById("dayTable");
    box.textContent = "";
    if (daily.length < 2) { box.hidden = true; return; }
    box.hidden = false;
    var t = el("table", "dtbl");
    var head = el("tr");
    ["Day", "Visits", "Page views", "Offer requests"].concat(withBots ? ["Bot visits", "Bot views"] : [])
      .forEach(function (h, i) { head.appendChild(el("th", i ? "n" : null, h)); });
    var thead = el("thead");
    thead.appendChild(head);
    t.appendChild(thead);
    var body = el("tbody");
    daily.slice().reverse().forEach(function (d) {
      var tr = el("tr", "go");
      tr.title = "See " + longDate(d.date) + " alone";
      tr.addEventListener("click", function () { openDay(d.date); });
      tr.appendChild(el("td", null, longDate(d.date)));
      [d.visits, d.views, d.leads].concat(withBots ? [d.botVisits || 0, d.botViews || 0] : [])
        .forEach(function (n) { tr.appendChild(el("td", "n", num(n))); });
      body.appendChild(tr);
    });
    t.appendChild(body);
    box.appendChild(t);
  }

  /* The visit log as the toggles want it: bots only with "Show bots", the
     owner's own only with "Hide my visits" off. */
  function visibleVisits(data, withBots, hideOwn) {
    return (data.visits || []).filter(function (v) {
      return (withBots || !v.bot) && (!hideOwn || !v.mine);
    });
  }

  function place(v) {
    if (v.country === "US") return [v.city, v.region].filter(Boolean).join(", ");
    return [v.city, v.country].filter(Boolean).join(", ");
  }

  function drawVisits(data, withBots, hideOwn) {
    var box = document.getElementById("visitLog");
    var rows = visibleVisits(data, withBots, hideOwn);
    var oneDay = data.from === data.to;
    box.textContent = "";
    document.getElementById("visitsHead").textContent =
      "Visits, one by one" + (rows.length ? " (" + num(rows.length) + ")" : "");

    if (!rows.length) {
      var why = "No visits were logged in this period.";
      if (!data.logStart || data.to < data.logStart) {
        why = "The visit-by-visit log " + (data.logStart
          ? "began on " + longDate(data.logStart) + ", so it has nothing for these days. "
          : "has not recorded anything yet. ")
          + "The totals above still cover them.";
      }
      box.appendChild(el("p", "note", why));
      return;
    }

    var wrap = el("div", "vlog-wrap");
    var t = el("table", "dtbl vtbl");
    var head = el("tr");
    [oneDay ? "Time" : "When", "Pages", "Came from", "Where", "Device"]
      .forEach(function (h) { head.appendChild(el("th", null, h)); });
    var thead = el("thead");
    thead.appendChild(head);
    t.appendChild(thead);
    var body = el("tbody");
    rows.slice(0, shownVisits).forEach(function (v) {
      var tr = el("tr");
      tr.appendChild(el("td", "when", oneDay ? v.time : shortDate(v.date) + ", " + v.time));

      var pg = el("td");
      pg.appendChild(document.createTextNode(v.pages.length + (v.pages.length === 1 ? " page" : " pages")));
      if (v.form) pg.appendChild(el("span", "tag" + (v.form === "Sent" ? " tag-lead" : ""),
        v.form === "Sent" ? "Sent the form" : "Form: " + v.form.toLowerCase()));
      if (v.bot) pg.appendChild(el("span", "tag tag-bot", "Bot " + v.score));
      if (v.mine) pg.appendChild(el("span", "tag", "You"));
      pg.appendChild(el("div", "path", v.pages.join(" → ")));
      tr.appendChild(pg);

      tr.appendChild(el("td", null, (v.source || "—") + (v.campaign ? " (" + v.campaign + ")" : "")));
      tr.appendChild(el("td", null, place(v) || "—"));
      tr.appendChild(el("td", null, v.device || "—"));
      body.appendChild(tr);
    });
    t.appendChild(body);
    wrap.appendChild(t);
    box.appendChild(wrap);

    if (rows.length > shownVisits) {
      var more = el("button", "backlink vlog-more",
        "Show more (" + num(rows.length - shownVisits) + " not shown)");
      more.type = "button";
      more.addEventListener("click", function () { shownVisits += 200; render(latest); });
      box.appendChild(more);
    }
    if (data.visitCount > (data.visits || []).length) {
      box.appendChild(el("p", "note", "The newest " + num(data.visits.length) + " of "
        + num(data.visitCount) + " visits are shown and exported; pick a shorter range for the rest."));
    }
  }

  /* Look at one day on its own; the button above the tiles goes back. */
  function openDay(date) {
    if (fromDate.value === date && toDate.value === date) return;
    if (!before) before = [fromDate.value, toDate.value, rangeSel.value];
    rangeSel.value = "custom";
    setRange(date, date);
    load();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function render(data) {
    latest = data;
    gate.hidden = true;
    dash.hidden = false;
    say("");

    var t = data.totals;
    var f = data.funnel || { starts: 0, step2: 0, step3: 0, submits: t.leads };
    var b = data.bots || { views: 0, visits: 0 };
    var me = data.owner || { towns: [], included: true, hidden: { views: 0, visits: 0 } };
    var mineNote = me.included ? "" : "; " + num(me.hidden.visits) + " of yours left out";
    var withBots = botToggle.checked;
    var perVisit = t.visits ? (t.views / t.visits).toFixed(1) : "0";
    var rate = t.visits ? ((t.leads / t.visits) * 100).toFixed(1) + "%" : "—";
    var finish = f.starts ? Math.round((f.submits / f.starts) * 100) + "%" : "—";

    var tiles = document.getElementById("tiles");
    tiles.textContent = "";
    tiles.appendChild(tile("Visits", num(t.visits),
      (withBots ? "people; plus " + num(b.visits) + " by bots" : "people, counted once per session")
      + mineNote));
    tiles.appendChild(tile("Page views", num(t.views),
      withBots ? "by people; plus " + num(b.views) + " by bots" : perVisit + " pages per visit"));
    tiles.appendChild(tile("Offer requests", num(t.leads), rate + " of visits"));
    tiles.appendChild(tile("Form finished", finish,
      num(f.starts) + " started it, " + num(f.submits) + " sent it"));

    if (me.towns.length) {
      document.getElementById("mineLabel").textContent =
        "Hide my visits (" + me.towns.join(", ") + ")";
    }

    document.querySelectorAll(".bot-only").forEach(function (n) { n.hidden = !withBots; });
    var old = document.querySelector(".chart-ends");
    if (old) old.remove();
    drawChart(data.daily, withBots);

    if (before) {
      dayBack.hidden = false;
      dayBackBtn.textContent = "← Back to " + rangeLabel(before[0], before[1]);
    } else {
      dayBack.hidden = true;
    }
    drawDayTable(data.daily, withBots);
    drawVisits(data, withBots, !me.included);

    var panels = document.getElementById("panels");
    panels.textContent = "";
    panels.appendChild(panel("The offer form", f.starts || f.submits ? [
      { name: "Started filling it in", count: f.starts },
      { name: "Reached step 2", count: f.step2 },
      { name: "Reached step 3", count: f.step3 },
      { name: "Sent", count: f.submits }
    ] : [], "Nobody has started the form in this period."));
    panels.appendChild(panel("Where visits came from", data.sources,
      "Nothing recorded yet."));
    panels.appendChild(panel("Pages read", data.pages,
      "Nothing recorded yet."));
    panels.appendChild(panel("States and regions", data.regions,
      "No region has been reported yet."));
    panels.appendChild(panel("Cities", data.cities,
      "No city has been reported yet."));
    panels.appendChild(panel("Countries", data.countries,
      "No country has been reported yet."));
    panels.appendChild(panel("Devices", data.devices,
      "Nothing recorded yet."));
    if (data.campaigns && data.campaigns.length) {
      panels.appendChild(panel("Campaigns", data.campaigns, ""));
    }

    if (withBots) {
      panels.appendChild(panel("Why they were marked as bots", data.botReasons,
        "No bots recorded in this period."));
      panels.appendChild(panel("Bot cities", data.botCities, "None."));
      panels.appendChild(panel("Bot countries", data.botCountries, "None."));
      panels.appendChild(panel("Pages bots loaded", data.botPages, "None."));
      var scores = (data.scores || []).filter(function (r) { return r.count; })
        .map(function (r) {
          var lo = Number(r.name);
          return { name: "Score " + lo + (lo < 100 ? "–" + (lo + 9) : "")
                   + (lo >= (data.threshold || 50) ? " (bot)" : ""), count: r.count };
        });
      /* Kept in score order, not by size, so the threshold reads as a line. */
      panels.appendChild(panel("Every page view by bot score", scores, "Nothing scored yet."));
    }

    document.getElementById("dashFoot").textContent =
      "Covering " + rangeLabel(data.from, data.to) + " (Eastern time), from the "
      + data.store + " store. A visit is one browser session; geography comes from the "
      + "network location of the connection, so it is accurate to the city at best and "
      + "wrong for anyone on a VPN. Bots are scored on their browser, location and "
      + "behaviour and kept apart from these numbers; that includes visits from "
      + "data-center towns such as Ashburn VA and Council Bluffs IA, and anyone who "
      + "left in under a second without touching the page. Days before bot scoring "
      + "began still have some bots mixed in. Visitors who ask not to be tracked are "
      + "not counted, so the real figures are a little higher than these."
      + (me.included ? "" : " Your own visits are left out by the town they come from ("
      + me.towns.join(", ") + "); on days before that was recorded separately, only the "
      + "visit and location counts could be corrected, so some of your page views remain.");
  }

  function load() {
    var key = remembered();
    if (!key) return askForKey(false);

    say("Loading…");
    shownVisits = 100;
    fetch("/api/track?from=" + encodeURIComponent(fromDate.value)
        + "&to=" + encodeURIComponent(toDate.value)
        + (mineToggle.checked ? "" : "&mine=include")
        + (botToggle.checked ? "&bots=1" : ""), {
      headers: { "x-traffic-key": key },
      cache: "no-store"
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          return { status: r.status, body: body };
        });
      })
      .then(function (res) {
        if (res.status === 401) { remember(""); return askForKey(true); }
        if (res.status === 503) {
          dash.hidden = true;
          gate.hidden = true;
          return say("Traffic recording is not switched on yet: set TRAFFIC_KEY in the "
                   + "Vercel project settings and redeploy.");
        }
        if (!res.body || !res.body.ok) {
          dash.hidden = true;
          return say("The dashboard could not read the numbers: "
                   + ((res.body && res.body.error) || "HTTP " + res.status) + ".");
        }
        if (res.body.store === "none") {
          dash.hidden = true;
          gate.hidden = true;
          return say(res.body.note);
        }
        render(res.body);
      })
      .catch(function () {
        say("Could not reach /api/track. Check the connection and try again.");
      });
  }

  /* A CSV of what is on screen, for a spreadsheet or for sending on: the
     days, every visit with its date and time, then the tables. */
  function csv() {
    if (!latest) return;
    function cell(v) { return '"' + String(v === undefined || v === null ? "" : v).replace(/"/g, '""') + '"'; }
    var lines = [["Date", "Visits", "Page views", "Offer requests",
                  "Bot visits", "Bot page views"].join(",")];
    latest.daily.forEach(function (d) {
      lines.push([d.date, d.visits, d.views, d.leads, d.botVisits || 0, d.botViews || 0].join(","));
    });

    /* Every visit, oldest first, as the toggles have it. */
    var visits = visibleVisits(latest, botToggle.checked, !(latest.owner || {}).included);
    if (visits.length) {
      lines.push("");
      lines.push(["Visit date", "Time (Eastern)", "Landing page", "Pages viewed", "Pages in order",
                  "Came from", "Campaign", "City", "State/region", "Country", "Device",
                  "Offer form", "Bot", "Bot score", "Your visit"].join(","));
      visits.slice().reverse().forEach(function (v) {
        lines.push([v.date, v.time, v.pages[0], v.pages.length, v.pages.join(" > "),
                    v.source, v.campaign, v.city, v.region, v.country, v.device,
                    v.form, v.bot ? "yes" : "", v.score, v.mine ? "yes" : ""].map(cell).join(","));
      });
    }
    [["Source", "sources"], ["Page", "pages"], ["Region", "regions"],
     ["City", "cities"], ["Country", "countries"], ["Device", "devices"],
     ["Campaign", "campaigns"], ["Bot reason", "botReasons"],
     ["Bot city", "botCities"], ["Bot country", "botCountries"]].forEach(function (pair) {
      var rows = latest[pair[1]] || [];
      if (!rows.length) return;
      lines.push("");
      lines.push([pair[0], "Count"].join(","));
      rows.forEach(function (r) {
        lines.push(['"' + String(r.name).replace(/"/g, '""') + '"', r.count].join(","));
      });
    });

    var blob = new Blob([lines.join("\n")], { type: "text/csv" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "hometownland-traffic-" + latest.from
      + (latest.from === latest.to ? "" : "-to-" + latest.to) + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  gate.addEventListener("submit", function (e) {
    e.preventDefault();
    var k = keyInput.value.trim();
    if (!k) return;
    remember(k);
    gate.hidden = true;
    load();
  });

  rangeSel.addEventListener("change", function () {
    before = null;
    if (rangeSel.value === "custom") { fromDate.focus(); return; }
    var r = presetRange(rangeSel.value);
    setRange(r[0], r[1]);
    load();
  });
  function datesChanged() {
    if (!fromDate.value || !toDate.value) return;
    before = null;
    if (fromDate.value > toDate.value) setRange(toDate.value, fromDate.value);
    rangeSel.value = "custom";
    load();
  }
  fromDate.addEventListener("change", datesChanged);
  toDate.addEventListener("change", datesChanged);
  dayBackBtn.addEventListener("click", function () {
    if (!before) return;
    setRange(before[0], before[1]);
    rangeSel.value = before[2];
    before = null;
    load();
  });

  /* Kept within what the server holds: today back 400 days. */
  fromDate.max = toDate.max = todayET();
  fromDate.min = toDate.min = addDays(todayET(), -399);
  var start = presetRange(rangeSel.value);
  setRange(start[0], start[1]);

  mineToggle.checked = hideMine();
  mineToggle.addEventListener("change", function () {
    try { localStorage.setItem(MINE_STORE, mineToggle.checked ? "hide" : "show"); } catch (e) {}
    load();
  });
  /* Bots' visit-by-visit lines are only fetched once they are asked for. */
  botToggle.addEventListener("change", function () {
    if (!latest) return;
    if (botToggle.checked && !latest.botLog) return load();
    render(latest);
  });
  document.getElementById("csvBtn").addEventListener("click", csv);
  document.getElementById("forgetBtn").addEventListener("click", function () {
    remember("");
    say("");
    askForKey(false);
  });

  /* ?key=… works once, for the first visit from a saved link, and is taken out
     of the address bar immediately so it is not left in history or copied on. */
  var fromUrl = new URLSearchParams(location.search).get("key");
  if (fromUrl) {
    remember(fromUrl.trim());
    history.replaceState(null, "", location.pathname);
  }

  load();
})();
