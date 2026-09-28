/* Hometown Land — the /stats dashboard.
   Reads the aggregate counters from /api/track and draws them. The key is held
   in this browser only; it is sent as a header rather than in the URL so it
   does not end up in a log or a shared link. */
(function () {
  "use strict";

  var gate = document.getElementById("keyGate");
  if (!gate) return;

  var KEY_STORE = "htl.statskey";
  var dash = document.getElementById("dash");
  var note = document.getElementById("dashNote");
  var keyInput = document.getElementById("keyInput");
  var keyMsg = document.getElementById("keyMsg");
  var rangeSel = document.getElementById("rangeSel");
  var botToggle = document.getElementById("botToggle");
  var latest = null;

  function remembered() {
    try { return localStorage.getItem(KEY_STORE) || ""; } catch (e) { return ""; }
  }
  function remember(k) {
    try { k ? localStorage.setItem(KEY_STORE, k) : localStorage.removeItem(KEY_STORE); } catch (e) {}
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
      var all = total(d);
      col.title = shortDate(d.date) + ": " + num(d.views) + " views, "
                + num(d.visits) + " visits"
                + (d.leads ? ", " + num(d.leads) + " offer requests" : "")
                + (withBots ? "; bots: " + num(d.botViews) + " views" : "");
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

  function render(data) {
    latest = data;
    gate.hidden = true;
    dash.hidden = false;
    say("");

    var t = data.totals;
    var f = data.funnel || { starts: 0, step2: 0, step3: 0, submits: t.leads };
    var b = data.bots || { views: 0, visits: 0 };
    var withBots = botToggle.checked;
    var perVisit = t.visits ? (t.views / t.visits).toFixed(1) : "0";
    var rate = t.visits ? ((t.leads / t.visits) * 100).toFixed(1) + "%" : "—";
    var finish = f.starts ? Math.round((f.submits / f.starts) * 100) + "%" : "—";

    var tiles = document.getElementById("tiles");
    tiles.textContent = "";
    tiles.appendChild(tile("Visits", num(t.visits),
      withBots ? "people; plus " + num(b.visits) + " by bots" : "people, counted once per session"));
    tiles.appendChild(tile("Page views", num(t.views),
      withBots ? "by people; plus " + num(b.views) + " by bots" : perVisit + " pages per visit"));
    tiles.appendChild(tile("Offer requests", num(t.leads), rate + " of visits"));
    tiles.appendChild(tile("Form finished", finish,
      num(f.starts) + " started it, " + num(f.submits) + " sent it"));

    document.querySelectorAll(".bot-only").forEach(function (n) { n.hidden = !withBots; });
    var old = document.querySelector(".chart-ends");
    if (old) old.remove();
    drawChart(data.daily, withBots);

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
      "Covering " + data.from + " through " + data.to + " (Eastern time), from the "
      + data.store + " store. A visit is one browser session; geography comes from the "
      + "network location of the connection, so it is accurate to the city at best and "
      + "wrong for anyone on a VPN. Bots are scored on their browser, location and "
      + "behaviour and kept apart from these numbers; that includes visits from "
      + "data-center towns such as Ashburn VA and Council Bluffs IA, and anyone who "
      + "left in under a second without touching the page. Days before bot scoring "
      + "began still have some bots mixed in. Visitors who ask not to be tracked are "
      + "not counted, so the real figures are a little higher than these.";
  }

  function load() {
    var key = remembered();
    if (!key) return askForKey(false);

    say("Loading…");
    fetch("/api/track?days=" + encodeURIComponent(rangeSel.value), {
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

  /* A CSV of what is on screen, for a spreadsheet or for sending on. */
  function csv() {
    if (!latest) return;
    var lines = [["Date", "Visits", "Page views", "Offer requests",
                  "Bot visits", "Bot page views"].join(",")];
    latest.daily.forEach(function (d) {
      lines.push([d.date, d.visits, d.views, d.leads, d.botVisits || 0, d.botViews || 0].join(","));
    });
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
    a.download = "hometownland-traffic-" + latest.from + "-to-" + latest.to + ".csv";
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

  rangeSel.addEventListener("change", load);
  botToggle.addEventListener("change", function () { if (latest) render(latest); });
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
