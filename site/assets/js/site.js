/* Hometown Land — multi-step offer form.
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

  function show(n) {
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
