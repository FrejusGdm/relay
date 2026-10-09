/* Shows the star count of relay's GitHub repository in the navigation's GitHub link.
   It asks GitHub's public API once an hour at most and keeps the answer in localStorage under
   "relay-github-stars". When the request fails, or the repository is private, the link shows no
   number. The request carries no cookie and no referrer. */
(function () {
  "use strict";
  var KEY = "relay-github-stars";
  var API = "https://api.github.com/repos/FrejusGdm/relay";
  var MAX_AGE = 60 * 60 * 1000;

  function format(count) {
    if (count < 1000) return String(count);
    var text = count < 10000 ? (count / 1000).toFixed(1) : String(Math.round(count / 1000));
    return text.replace(/\.0$/, "") + "k";
  }

  function show(link, count) {
    var text = format(count);
    link.querySelector("[data-gh-stars]").textContent = text;
    link.setAttribute("aria-label", "relay on GitHub, " + text + (count === 1 ? " star" : " stars"));
  }

  function cached() {
    try {
      var saved = JSON.parse(localStorage.getItem(KEY));
      if (saved && typeof saved.count === "number" && Date.now() - saved.time < MAX_AGE) return saved.count;
    } catch (e) {}
    return null;
  }

  document.addEventListener("DOMContentLoaded", function () {
    var link = document.querySelector("[data-gh-link]");
    if (!link) return;
    var count = cached();
    if (count !== null) return show(link, count);
    fetch(API, { credentials: "omit", referrerPolicy: "no-referrer" })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (repo) {
        if (!repo || typeof repo.stargazers_count !== "number") return;
        show(link, repo.stargazers_count);
        try {
          localStorage.setItem(KEY, JSON.stringify({ count: repo.stargazers_count, time: Date.now() }));
        } catch (e) {}
      })
      .catch(function () {});
  });
})();
