/* Hometown Land — site behaviour: the traffic beacon, then the offer form. */

/* Traffic beacon.
   Tells /api/track that a page was read. Aggregate counts only: no cookie, no
   identifier, nothing that outlives the browser tab. The one thing kept per
   visit is a sessionStorage marker saying "this tab has already been counted",
   so a person reading four pages is one visit rather than four.
   A visitor sending Do Not Track is not counted at all.

   The beacon waits until the page has been read before it goes: the first
   scroll, tap, click or key, ten seconds on screen, or the tab being hidden,
   whichever comes first. What it carries alongside the page -- screen size,
   timezone, whether the browser is being driven by a script, how long the page
   was open -- is what the server uses to tell a person from a headless
   browser. It is scored there and thrown away; only the verdict is counted. */
(function () {
  "use strict";

  function post(payload) {
    try {
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        /* sendBeacon survives the page being navigated away from, which is
           exactly what happens on the form's redirect to /thank-you. */
        navigator.sendBeacon("/api/track", new Blob([body], { type: "application/json" }));
      } else {
        fetch("/api/track", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body,
          keepalive: true
        }).catch(function () { /* a missed count is not worth a console error */ });
      }
    } catch (e) { /* ditto */ }
  }

  /* Reading your own dashboard is not traffic. */
  if (location.pathname.indexOf("/stats") === 0) return;

  /* An explicit "do not track me" is honoured, which means the totals run a
     few percent under the true figure. That is the trade, and it is stated on
     the dashboard so nobody reads the gap as lost traffic. */
  var dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
  if (dnt === "1" || dnt === "yes") return;

  /* The visit marker, "pages|touched": how many pages this tab has shown and
     whether any of them was scrolled, clicked or typed in. sessionStorage is
     per tab and emptied when the tab closes. Where it is unavailable -- private
     modes block it -- fall back to "did they arrive from somewhere other than
     this site", and go without the page count. */
  var MARK = "htl.seen";
  var pages = 0, touchedBefore = false, first;
  try {
    var mark = (sessionStorage.getItem(MARK) || "").split("|");
    first = !mark[0];
    pages = (parseInt(mark[0], 10) || 0) + 1;
    touchedBefore = mark[1] === "1";
  } catch (e) {
    first = document.referrer.indexOf(location.origin) !== 0;
  }
  function saveMark(touched) {
    try { sessionStorage.setItem(MARK, pages + "|" + (touched || touchedBefore ? 1 : 0)); } catch (e) {}
  }
  saveMark(false);

  var q = new URLSearchParams(location.search);
  var opened = Date.now();
  var sent = false;
  var tz = "";
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}

  function send(touched) {
    if (sent) return;
    sent = true;
    post({
      v: 2,
      p: location.pathname,
      r: document.referrer,
      s: q.get("utm_source") || q.get("ref") || "",
      c: q.get("utm_campaign") || "",
      n: first ? 1 : 0,
      w: screen.width || 0,
      h: screen.height || 0,
      z: tz,
      d: navigator.webdriver ? 1 : 0,
      t: Date.now() - opened,
      i: touched ? 1 : 0,
      sv: pages,
      si: touchedBefore ? 1 : 0
    });
  }

  /* Remembered for the visit even when it comes after the beacon has gone. */
  function touched() { saveMark(true); send(true); }
  ["scroll", "pointerdown", "keydown", "touchstart"].forEach(function (type) {
    addEventListener(type, touched, { once: true, passive: true, capture: true });
  });
  setTimeout(function () {
    if (document.visibilityState !== "hidden") send(false);
  }, 10000);
  function hidden() { if (document.visibilityState === "hidden") send(false); }
  document.addEventListener("visibilitychange", hidden);
  addEventListener("pagehide", function () { send(false); });

  /* Named events: the offer form's progress and a submitted request, so the
     dashboard can show where people drop out of the form. */
  window.htlEvent = function (name, extra) {
    var payload = { e: name };
    if (extra) for (var k in extra) payload[k] = extra[k];
    post(payload);
  };
})();

/* Multi-step offer form.
   Progressive enhancement: without JS every fieldset is visible and the form
   still posts normally to /api/lead. */
(function () {
  "use strict";

  var form = document.getElementById("offerForm");
  if (!form) return;

  var steps = form.querySelectorAll(".step");
  var pips = document.querySelectorAll(".pbar div");
  var errBox = document.getElementById("formErr");
  var submitBtn = document.getElementById("submitBtn");

  /* Funnel events: the first time anybody types in or picks from the form,
     and the first time each later step is reached. */
  var reached = {};
  function track(name, step) {
    var id = name + (step || "");
    if (reached[id] || !window.htlEvent) return;
    reached[id] = true;
    window.htlEvent(name, step ? { step: step } : null);
  }
  form.addEventListener("focusin", function () { track("form_start"); });

  function show(n) {
    if (Number(n) > 1) track("form_step", Number(n));
    steps.forEach(function (s) { s.classList.toggle("on", s.getAttribute("data-s") === n); });
    pips.forEach(function (p) { p.classList.toggle("on", p.getAttribute("data-p") === n); });
    var card = document.getElementById("offer");
    if (card && card.getBoundingClientRect().top < 0) {
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    var first = form.querySelector('.step.on input, .step.on select');
    if (first) first.focus({ preventScroll: true });
  }

  function fieldError(el, on) {
    el.setAttribute("aria-invalid", on ? "true" : "false");
    var msg = form.querySelector('.msg[data-for="' + el.id + '"]');
    if (msg) msg.classList.toggle("on", on);
  }

  /* Validate only the fields inside the step being left. */
  function validateStep(step) {
    var ok = true, firstBad = null;
    step.querySelectorAll("[required]").forEach(function (el) {
      var bad = !el.value.trim() || (el.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(el.value));
      fieldError(el, bad);
      if (bad && !firstBad) firstBad = el;
      if (bad) ok = false;
    });
    if (firstBad) firstBad.focus();
    return ok;
  }

  form.querySelectorAll("[data-next]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var target = btn.getAttribute("data-next");
      var current = btn.closest(".step");
      var goingForward = Number(target) > Number(current.getAttribute("data-s"));
      if (goingForward && !validateStep(current)) return;
      show(target);
    });
  });

  /* Clear a field's error as soon as it is corrected. */
  form.addEventListener("input", function (e) {
    if (e.target.getAttribute("aria-invalid") === "true") fieldError(e.target, false);
    if (e.target.id === "phone") {
      var cm = form.querySelector('.msg[data-for="smsConsent"]');
      if (cm) cm.classList.remove("on");
    }
  });

  /* Enter should advance a step rather than submit early. */
  form.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || e.target.tagName === "TEXTAREA") return;
    var step = e.target.closest(".step");
    if (!step) return;
    var next = step.querySelector("[data-next]");
    if (next && Number(next.getAttribute("data-next")) > Number(step.getAttribute("data-s"))) {
      e.preventDefault();
      next.click();
    }
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    errBox.classList.remove("on");

    var last = form.querySelector('.step[data-s="3"]');
    if (!validateStep(last)) return;

    /* SMS consent needs a number to send to. */
    var consent = document.getElementById("smsConsent");
    var phone = document.getElementById("phone");
    var consentMsg = form.querySelector('.msg[data-for="smsConsent"]');
    if (consent && consent.checked && phone && !phone.value.trim()) {
      fieldError(phone, true);
      if (consentMsg) consentMsg.classList.add("on");
      phone.focus();
      return;
    }
    if (consentMsg) consentMsg.classList.remove("on");

    var data = {};
    new FormData(form).forEach(function (v, k) { data[k] = typeof v === "string" ? v.trim() : v; });
    data.submittedAt = new Date().toISOString();
    data.pageUrl = location.pathname;

    submitBtn.disabled = true;
    submitBtn.textContent = "Sending…";

    fetch(form.action, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        if (window.htlEvent) window.htlEvent("lead");
        window.location.href = "/thank-you";
      })
      .catch(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit My Property";
        errBox.textContent =
          "We could not send that just now. Please try again, or email brian@gohometownland.com with your property details.";
        errBox.classList.add("on");
        errBox.scrollIntoView({ behavior: "smooth", block: "center" });
      });
  });
})();
