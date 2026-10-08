/* The license page (add-lifetime-license, design decision 12). It reads session_id from the address,
   asks /api/license on this site for the key, and shows one state. It stores nothing, and the
   session ID goes only to this site's own API. */
(function () {
  "use strict";
  var TEXT = {
    loading: "Getting your license key…",
    pending: "Your payment is still processing. Your key appears on this page when the payment completes. Reload it later.",
    not_found: "This link does not lead to a paid order. If you paid, write to the support address on your Stripe receipt.",
    error: "Something went wrong on our side. Nothing was charged twice. Reload this page in a minute."
  };
  var state = document.getElementById("license-state");
  var issued = document.getElementById("license-issued");
  var copyStatus = document.getElementById("copy-status");

  function show(name) {
    state.textContent = TEXT[name];
    state.hidden = false;
    issued.hidden = true;
  }

  function showKey(key) {
    document.getElementById("license-key").textContent = key;
    document.getElementById("license-command").textContent = "relay license activate " + key;
    state.hidden = true;
    issued.hidden = false;
  }

  /* The button's label says whether copying worked, for 1.6 seconds. */
  function copyText(text, button) {
    if (!button.hasAttribute("data-label")) button.setAttribute("data-label", button.textContent);
    var done = function (ok) {
      button.textContent = ok ? "Copied" : "Copy failed";
      copyStatus.textContent = ok ? "Copied." : "Copying failed. Select the text and copy it by hand.";
      setTimeout(function () { button.textContent = button.getAttribute("data-label"); }, 1600);
    };
    var fallback = function () {
      var ok = false;
      try {
        var area = document.createElement("textarea");
        area.value = text; area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0";
        button.parentNode.appendChild(area); area.select();
        ok = document.execCommand("copy");
        area.remove();
      } catch (e) {}
      button.focus();
      done(ok);
    };
    try {
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    } catch (e) { fallback(); }
  }

  document.querySelectorAll("[data-copy]").forEach(function (button) {
    button.addEventListener("click", function () {
      copyText(document.getElementById(button.getAttribute("data-copy")).textContent, button);
    });
  });

  var sessionId = new URLSearchParams(window.location.search).get("session_id");
  if (!sessionId) {
    show("not_found");
    return;
  }
  show("loading");
  fetch("/api/license?session_id=" + encodeURIComponent(sessionId), { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" })
    .then(function (response) {
      return response.json().then(function (body) { return { status: response.status, body: body }; });
    })
    .then(function (result) {
      if (result.status === 200 && result.body.state === "issued" && typeof result.body.key === "string") showKey(result.body.key);
      else if (result.status === 202) show("pending");
      else if (result.status === 404) show("not_found");
      else show("error");
    }, function () { show("error"); });
})();
