/* Applies the visitor's theme before the page is drawn, and runs the theme button in the navigation.
   Loaded in <head> without defer, so data-theme is set on <html> before the first paint.
   There are two themes, light and dark. The choice is kept in localStorage under "relay-theme";
   without it the page is light. The button's icons are swapped by styles.css from data-theme. */
(function () {
  "use strict";
  var KEY = "relay-theme";
  var root = document.documentElement;

  function savedTheme() {
    try {
      var value = localStorage.getItem(KEY);
      if (value === "dark") return "dark";
    } catch (e) {}
    return "light";
  }

  function apply(theme) {
    root.setAttribute("data-theme", theme);
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute("content", theme);
    var button = document.getElementById("theme-toggle");
    if (button) {
      var label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
    }
  }

  var theme = savedTheme();
  apply(theme);

  document.addEventListener("DOMContentLoaded", function () {
    apply(theme);
    var button = document.getElementById("theme-toggle");
    if (!button) return;
    button.addEventListener("click", function () {
      theme = theme === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(KEY, theme);
      } catch (e) {}
      apply(theme);
    });
  });
})();
