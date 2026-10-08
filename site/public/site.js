(function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function svgEl(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function half(v) { return Math.round(v) + 0.5; }

  /* Static track drawing for the closing panel */
  function drawTrack(g, W, ys, o) {
    while (g.firstChild) g.removeChild(g.firstChild);
    function blocked(x, y1, y2) {
      var boxes = o.boxes || [];
      for (var j = 0; j < boxes.length; j++) {
        var b = boxes[j];
        if (x > b.l - 20 && x < b.r + 20 && Math.max(y1, y2) > b.t - 24 && Math.min(y1, y2) < b.b + 24) return true;
      }
      return false;
    }
    ys.forEach(function (y) {
      // A lane that would cross the text starts to the right of it.
      var x1 = 0;
      (o.text || []).forEach(function (b) { if (y > b.t - 24 && y < b.b + 24) x1 = Math.max(x1, Math.round(b.r + 20)); });
      if (x1 < W) svgEl("line", { "class": "trk-line", x1: x1, y1: y, x2: W, y2: y }, g);
    });
    (o.switches || []).forEach(function (s) {
      var x = half(o.x0 + s.f * (W - o.x0));
      var ya = ys[s.a], yb = ys[s.b];
      if (x > W - 12 || blocked(x, ya, yb)) return;
      svgEl("line", { "class": "trk-line", x1: x, y1: ya, x2: x, y2: yb }, g);
      svgEl("rect", { "class": "trk-node", x: x - 2.5, y: ya - 2.5, width: 5, height: 5 }, g);
      svgEl("rect", { "class": "trk-node", x: x - 2.5, y: yb - 2.5, width: 5, height: 5 }, g);
    });
    ys.forEach(function (y, i) {
      (o.stations[i] || []).forEach(function (f) {
        var x = half(o.x0 + f * (W - o.x0));
        if (x < o.x0 + 24 || x > W - 24 || blocked(x, y, y)) return;
        svgEl("rect", { "class": "trk-node", x: x - 3.5, y: y - 3.5, width: 7, height: 7 }, g);
      });
    });
  }

  /* ===== relay card start =====
     Mounts the handoff card and runs its 7.2-second story (adapted from Codex's card.html).
     The checkpoint drawing stays in place; data-step colors it for each stage.
     The returned setInView(bool) pauses it off screen. */
  function mountRelayCard(host) {
    host.appendChild(document.getElementById("card-tpl").content.cloneNode(true));
    var root = host.querySelector(".rc");
    var $ = function (n) { return root.querySelector('[data-rc="' + n + '"]'); };
    var reducedQ = window.matchMedia("(prefers-reduced-motion: reduce)");
    var DURATION = 7200;
    var stages = [
      { at: 0, line: "<strong>Claude Code is working</strong> · building authentication", claude: "Working", codex: "Ready", caption: "<b>Next worker: Codex</b>Same repository &amp; plan" },
      { at: 1300, line: "<strong>Claude Code is working</strong> · usage running out", claude: "Usage running out", codex: "Ready", caption: "<b>Next worker: Codex</b>Same repository &amp; plan" },
      { at: 2600, line: "<strong>Limit reached</strong> · resets <time>18:00</time>", claude: "Limit reached", codex: "Ready", caption: "<b>Waiting for your manual switch</b>Next worker: Codex" },
      { at: 3700, line: "<strong>Saving checkpoint</strong> · keeping the repository &amp; plan", claude: "Limit · resets <time>18:00</time>", codex: "Ready", caption: "<b>Saving the work before switching</b>Checkpoint + plan" },
      { at: 4800, line: "<strong>Moving the job to Codex</strong> · manual switch", claude: "Limit · resets <time>18:00</time>", codex: "Receiving work", caption: '<b>Manual switch · <time>14:19</time></b>Moving checkpoint <span class="mono">912ec1</span> + plan' },
      { at: 6000, line: "<strong>Moved to Codex</strong> · Claude Code reached its limit", claude: "Limit · resets <time>18:00</time>", codex: "Working", caption: '<b>Handed off manually · <time>14:19</time></b>at checkpoint <span class="mono">912ec1</span>' }
    ];
    var elapsed = 0, lastTime = 0, raf = 0, index = -1, paused = false, inView = false, running = false, animations = [];
    var ease = "cubic-bezier(0.22, 1, 0.36, 1)";
    var pauseBtn = $("pause");
    function entrance(el) {
      if (reducedQ.matches) return;
      animations.push(el.animate([{ opacity: 0, transform: "translateY(3px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 220, easing: ease }));
    }
    function settle(el, duration) {
      if (reducedQ.matches) return;
      animations.push(el.animate([{ opacity: 0.6, transform: "translateY(3px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: duration, easing: ease }));
    }
    function render(i, animate) {
      index = i;
      root.dataset.step = String(i);
      var s = stages[i];
      $("line").innerHTML = s.line;
      $("claude-state").innerHTML = s.claude;
      $("codex-state").textContent = s.codex;
      $("transfer").innerHTML = s.caption;
      $("claude-role").textContent = i < 2 ? "Current worker" : "Previous worker";
      $("codex-role").textContent = i < 4 ? "Next worker" : "Current worker";
      $("claude-state").className = "rc-state " + (i < 2 ? "working" : "warning");
      $("codex-state").className = "rc-state" + (i >= 4 ? " working" : "");
      $("hash").textContent = i < 3 ? "8f4a20" : i === 3 ? "Saving…" : "912ec1";
      $("drawing-hash").textContent = $("hash").textContent;
      $("saved").innerHTML = i < 3 ? "· previous" : i === 3 ? "" : "· saved <time>14:19</time>";
      $("open-label").textContent = i < 4 ? "Open Claude Code" : "Open Codex";
      if (animate) entrance($("line"));
      // The checkpoint settles when it is saved, and the next worker when the job moves to it.
      if (animate && i === 3) settle(root.querySelector(".rc-checkpoint"), 250);
      if (animate && i === 4) settle(root.querySelector(".rc-symbol-to"), 180);
      if (i === 5) $("announce").textContent = "Moved to Codex. Claude Code reached its limit. Checkpoint and plan carried over.";
    }
    function finish() {
      running = false; elapsed = DURATION;
      pauseBtn.disabled = true; pauseBtn.textContent = "Pause"; pauseBtn.setAttribute("aria-pressed", "false");
    }
    function frame(t) {
      if (paused || !inView || document.hidden) { lastTime = 0; return; }
      if (lastTime) elapsed += t - lastTime;
      lastTime = t;
      var i = stages.length - 1;
      while (i > 0 && elapsed < stages[i].at) i--;
      if (i !== index) render(i, true);
      if (elapsed >= DURATION) { finish(); return; }
      raf = requestAnimationFrame(frame);
    }
    function play() {
      cancelAnimationFrame(raf);
      animations.forEach(function (a) { a.cancel(); });
      animations = [];
      elapsed = 0; lastTime = 0; paused = false;
      $("announce").textContent = "";
      pauseBtn.textContent = "Pause"; pauseBtn.setAttribute("aria-pressed", "false");
      if (reducedQ.matches) { render(5, false); finish(); return; }
      running = true;
      pauseBtn.disabled = false;
      index = -1; render(0, true);
      raf = requestAnimationFrame(frame);
    }
    function resumeClock() {
      if (paused || !inView || document.hidden) return;
      animations.forEach(function (a) { if (a.playState === "paused") a.play(); });
      if (running) { lastTime = 0; cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); }
    }
    function suspendClock() {
      cancelAnimationFrame(raf); lastTime = 0;
      animations.forEach(function (a) { if (a.playState === "running") a.pause(); });
    }
    pauseBtn.addEventListener("click", function () {
      if (!running) return;
      paused = !paused;
      pauseBtn.textContent = paused ? "Resume" : "Pause";
      pauseBtn.setAttribute("aria-pressed", String(paused));
      if (paused) suspendClock(); else resumeClock();
    });
    $("replay").addEventListener("click", play);
    $("pin").addEventListener("click", function () {
      var pinned = $("pin").getAttribute("aria-pressed") !== "true";
      $("pin").setAttribute("aria-pressed", String(pinned));
      $("pin").querySelector("span").textContent = pinned ? "Pinned" : "Pin";
    });
    root.querySelectorAll("[data-dialog]").forEach(function (button) {
      button.addEventListener("click", function () {
        if (button.dataset.dialog === "worker") {
          var who = index < 4 ? "Claude Code" : "Codex";
          $("worker-title").textContent = who + " worker";
          $("worker-detail").innerHTML = who === "Claude Code"
            ? "This illustrated worker is building authentication in relay / auth. The next worker will receive the saved checkpoint and plan."
            : 'This illustrated worker continues “Build authentication” in relay / auth with checkpoint <span class="mono">912ec1</span> and the saved plan.';
        }
        var d = root.querySelector('[data-rc-dialog="' + button.dataset.dialog + '"]');
        if (d && d.showModal) d.showModal();
      });
    });
    document.addEventListener("visibilitychange", function () { if (document.hidden) suspendClock(); else resumeClock(); });
    if (reducedQ.matches) { $("note").textContent = "Illustrated manual handoff · reduced motion"; render(5, false); pauseBtn.disabled = true; }
    else render(0, false);
    return {
      play: play,
      setInView: function (v) { inView = v; if (v) resumeClock(); else suspendClock(); }
    };
  }
  /* ===== relay card end ===== */

  /* Hero: the handoff card */
  var story = document.getElementById("story");
  var relayCard = mountRelayCard(document.getElementById("hero-card"));

  /* An element's box in the local pixels of a container, safe under CSS zoom */
  function rel(el, base) {
    var b = base.getBoundingClientRect(), r = el.getBoundingClientRect(), k = base.offsetWidth / (b.width || 1);
    return { left: (r.left - b.left) * k, top: (r.top - b.top) * k, right: (r.right - b.left) * k, bottom: (r.bottom - b.top) * k, width: r.width * k, height: r.height * k };
  }

  function hidden(el) { return getComputedStyle(el).display === "none"; }

  /* Closing panel map */
  var panel = document.getElementById("panel");
  function layoutPanel() {
    if (hidden(panel.querySelector(".map"))) return;
    var W = panel.clientWidth, H = panel.clientHeight;
    if (!W || !H) return;
    var ys = [0, 1, 2, 3].map(function (i) { return half(36 + i * (H - 72) / 3); });
    document.getElementById("panel-svg").setAttribute("viewBox", "0 0 " + W + " " + H);
    var ir = rel(panel.querySelector(".panel-in"), panel), ph = rel(panel.querySelector("h2"), panel);
    var textBox = { l: ir.left, r: Math.max(ph.right, ir.left + 320), t: ir.top, b: ir.bottom };
    drawTrack(document.getElementById("panel-static"), W, ys, {
      x0: 0, boxes: [textBox], text: [textBox],
      stations: [[0.58, 0.8, 0.94], [0.66, 0.88], [0.52, 0.74, 0.9], [0.7, 0.96]],
      switches: [{ a: 0, b: 1, f: 0.72 }, { a: 1, b: 2, f: 0.84 }, { a: 2, b: 3, f: 0.62 }, { a: 1, b: 2, f: 0.28 }]
    });
  }

  var rafId = 0;
  function relayout() {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(function () { layoutPanel(); layoutGraph(); });
  }

  /* Hero story: the card plays when it comes into view and pauses off screen */
  var started = false;
  if (!reduce && "IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        relayCard.setInView(e.isIntersecting);
        if (e.isIntersecting && !started) { started = true; relayCard.play(); }
      });
    }, { threshold: 0.2 }).observe(story);
  } else if (!reduce) {
    relayCard.setInView(true); relayCard.play();
  }
  /* Task graph: nine tasks and eleven dependencies at fixed positions, joined by rounded
     connectors between their ports. When it first comes into view it plays its three moments once
     (17:40 running, 17:52 Claude's tasks paused, 18:00 resumed) and holds the last one.
     Selecting a task highlights the connectors and tasks around it. */
  var tg = document.getElementById("tg");
  var tgEdges = document.getElementById("tg-edges");
  var NODES = [
    { id: "plan", t: "Plan the job", p: "claude", dc: 1, dr: 2, mc: 2, mr: 1, s: "Done" },
    { id: "cb", t: "Callback route", p: "claude", dc: 2, dr: 1, mc: 1, mr: 2, s: "Working" },
    { id: "tbl", t: "Sessions table", p: "codex", dc: 2, dr: 2, mc: 2, mr: 2, s: "Working" },
    { id: "ui", t: "Sign-in page", p: "codex", dc: 2, dr: 3, mc: 3, mr: 2, s: "Working" },
    { id: "tst", t: "Callback tests", p: "codex", dc: 3, dr: 1, mc: 1, mr: 3, s: "Working" },
    { id: "ref", t: "Token refresh", p: "claude", dc: 3, dr: 2, mc: 2, mr: 3, s: "Working" },
    { id: "sto", t: "Session store", p: "codex", dc: 3, dr: 3, mc: 3, mr: 3, s: "Working" },
    { id: "out", t: "Sign-out everywhere", p: "claude", dc: 4, dr: 2, mc: 2, mr: 4, s: "Working" },
    { id: "rev", t: "Review", p: "claude", dc: 5, dr: 2, mc: 2, mr: 5, s: "Waiting" }
  ];
  var EDGES = [["plan", "cb"], ["plan", "tbl"], ["plan", "ui"], ["cb", "tst"], ["cb", "ref"], ["tbl", "ref"], ["ui", "sto"], ["tst", "out"], ["ref", "out"], ["sto", "out"], ["out", "rev"]];
  var PAUSABLE = ["cb", "ref", "out", "rev"];
  var PROVIDER = { claude: { name: "Claude", logo: "/logos/claude.svg", mark: "brand-mark" }, codex: { name: "Codex", logo: "/logos/openai.svg", mark: "brand-mark brand-mono" } };
  var nodeEl = {}, taskName = {};
  NODES.forEach(function (n) {
    var d = document.createElement("button");
    var pv = PROVIDER[n.p];
    d.type = "button";
    d.className = "tg-node " + n.p;
    d.dataset.node = n.id;
    d.setAttribute("aria-pressed", "false");
    d.style.setProperty("--dc", n.dc); d.style.setProperty("--dr", n.dr);
    d.style.setProperty("--mc", n.mc); d.style.setProperty("--mr", n.mr);
    var paus = PAUSABLE.indexOf(n.id) > -1;
    d.innerHTML = '<span class="nt"></span><span class="nm2"><span class="pv"><img class="' + pv.mark + '" src="' + pv.logo + '" alt="" width="14" height="14">' + pv.name + '</span><span class="stack sw2"><span class="w"></span>' + (paus ? '<span class="p">Paused</span>' : "") + "</span></span>";
    d.querySelector(".nt").textContent = n.t;
    d.querySelector(".w").textContent = n.s;
    d.addEventListener("click", function () { selectTask(n.id); });
    tg.appendChild(d);
    nodeEl[n.id] = d;
    taskName[n.id] = n.t;
  });
  var phase = 0, selected = "";

  function edgePaused(e) { return phase === 1 && (PAUSABLE.indexOf(e[0]) > -1 || PAUSABLE.indexOf(e[1]) > -1); }

  /* A path through the points with each corner rounded to the given radius */
  function roundedPath(points, radius) {
    var d = "M" + points[0][0] + " " + points[0][1];
    for (var i = 1; i < points.length - 1; i++) {
      var a = points[i - 1], b = points[i], c = points[i + 1];
      var ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
      if (!ab || !bc) continue;
      var r = Math.min(radius, ab / 2, bc / 2);
      d += " L" + (b[0] + (a[0] - b[0]) * r / ab) + " " + (b[1] + (a[1] - b[1]) * r / ab) +
        " Q" + b[0] + " " + b[1] + " " + (b[0] + (c[0] - b[0]) * r / bc) + " " + (b[1] + (c[1] - b[1]) * r / bc);
    }
    var end = points[points.length - 1];
    return d + " L" + end[0] + " " + end[1];
  }

  function layoutGraph() {
    var vertical = tg.clientWidth < 880;
    tg.classList.toggle("vertical", vertical);
    tgEdges.setAttribute("viewBox", "0 0 " + tg.clientWidth + " " + tg.clientHeight);
    while (tgEdges.firstChild) tgEdges.removeChild(tgEdges.firstChild);
    EDGES.forEach(function (e) {
      var a = rel(nodeEl[e[0]], tg), b = rel(nodeEl[e[1]], tg), x1, y1, x2, y2, pts;
      if (!vertical) {
        // From the right-hand port of one task to the left-hand port of the next
        x1 = a.right; y1 = a.top + a.height / 2; x2 = b.left; y2 = b.top + b.height / 2;
        var xm = (x1 + x2) / 2;
        pts = Math.abs(y1 - y2) < 1 ? [[x1, y1], [x2, y2]] : [[x1, y1], [xm, y1], [xm, y2], [x2, y2]];
      } else {
        // From the bottom port to the top port
        x1 = a.left + a.width / 2; y1 = a.bottom; x2 = b.left + b.width / 2; y2 = b.top;
        var ym = (y1 + y2) / 2;
        pts = Math.abs(x1 - x2) < 1 ? [[x1, y1], [x2, y2]] : [[x1, y1], [x1, ym], [x2, ym], [x2, y2]];
      }
      svgEl("path", { d: roundedPath(pts, 8), "data-from": e[0], "data-to": e[1] }, tgEdges);
    });
    paintEdges();
  }
  function paintEdges() {
    tgEdges.querySelectorAll("path").forEach(function (path) {
      var e = [path.getAttribute("data-from"), path.getAttribute("data-to")];
      path.classList.toggle("paused-edge", edgePaused(e));
      path.classList.toggle("focused-edge", selected !== "" && e.indexOf(selected) > -1);
    });
  }

  /* Selecting a task (click, Enter or Space) highlights it, its connectors and its neighbours;
     selecting it again clears the highlight. A screen reader hears the same relationships. */
  function names(ids) {
    var list = ids.map(function (id) { return taskName[id]; });
    return list.length > 1 ? list.slice(0, -1).join(", ") + " and " + list[list.length - 1] : list[0];
  }
  function selectTask(id) {
    selected = selected === id ? "" : id;
    if (selected) tg.setAttribute("data-focus", selected); else tg.removeAttribute("data-focus");
    var before = [], after = [];
    EDGES.forEach(function (e) {
      if (e[1] === selected) before.push(e[0]);
      if (e[0] === selected) after.push(e[1]);
    });
    NODES.forEach(function (n) {
      nodeEl[n.id].classList.toggle("focused-node", n.id === selected);
      nodeEl[n.id].classList.toggle("related-node", before.indexOf(n.id) > -1 || after.indexOf(n.id) > -1);
      nodeEl[n.id].setAttribute("aria-pressed", String(n.id === selected));
    });
    paintEdges();
    document.getElementById("tg-announce").textContent = !selected ? "No task selected." :
      taskName[selected] + " depends on " + (before.length ? names(before) : "no other task") + ". " +
      (after.length ? names(after) + (after.length > 1 ? " depend" : " depends") + " on it." : "No task depends on it.");
  }

  function setPhase(p) {
    phase = p;
    document.querySelectorAll("#tg-phase > span, #tg-clock > span").forEach(function (s) { s.style.opacity = Number(s.dataset.ph) === p ? "1" : "0"; });
    NODES.forEach(function (n) {
      var paused = p === 1 && PAUSABLE.indexOf(n.id) > -1;
      nodeEl[n.id].classList.toggle("is-paused", paused);
      nodeEl[n.id].setAttribute("aria-label", n.t + ", " + PROVIDER[n.p].name + ", " + (paused ? "paused" : n.s.toLowerCase()));
    });
    paintEdges();
  }

  /* Playback: a quarter-second clock that runs only while the graph is on screen, the page is
     visible and the visitor has not paused it. */
  var tgFig = document.querySelector(".tg-fig");
  var tgPause = document.getElementById("tg-pause");
  var MOMENTS = [0, 7, 11.5]; // seconds at which 17:40, 17:52 and 18:00 begin
  var tgClock = 0, tgTimer = 0, tgVisible = false, tgPaused = false, tgStarted = false;
  function setGraphPaused(v) {
    tgPaused = v;
    tgPause.textContent = v ? "Resume" : "Pause";
    tgPause.setAttribute("aria-pressed", String(v));
  }
  function stopGraph() {
    clearInterval(tgTimer); tgTimer = 0;
    setGraphPaused(false);
    tgPause.disabled = true;
  }
  function tickGraph() {
    if (!tgVisible || document.hidden || tgPaused) return;
    tgClock += 0.25;
    var p = tgClock < MOMENTS[1] ? 0 : (tgClock < MOMENTS[2] ? 1 : 2);
    if (p !== phase) setPhase(p);
    if (p === 2) stopGraph();
  }
  function playGraph() {
    stopGraph();
    tgClock = 0;
    if (reduce) { setPhase(2); return; }
    setPhase(0);
    tgPause.disabled = false;
    tgTimer = setInterval(tickGraph, 250);
  }
  tgPause.addEventListener("click", function () { if (tgTimer) setGraphPaused(!tgPaused); });
  document.getElementById("tg-replay").addEventListener("click", playGraph);
  if (reduce) {
    document.getElementById("tg-caption").textContent = "Illustrated. The first release switches one job at a time. Motion is reduced, so the graph is still.";
    playGraph();
  } else {
    setPhase(0);
    tgPause.disabled = true;
    var startGraph = function () { if (!tgStarted) { tgStarted = true; playGraph(); } };
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { tgVisible = e.isIntersecting; if (tgVisible) startGraph(); });
      }, { threshold: 0.15 }).observe(tgFig);
    } else { tgVisible = true; startGraph(); }
  }

  layoutPanel(); layoutGraph();
  if ("ResizeObserver" in window) {
    var ro = new ResizeObserver(relayout);
    ro.observe(panel); ro.observe(tg);
  }
  window.addEventListener("resize", relayout);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);

  /* Copying: the button's label says whether it worked, for 1.6 seconds. */
  function copyText(text, button, label, onDone) {
    if (!label.hasAttribute("data-label")) label.setAttribute("data-label", label.textContent);
    var done = function (ok) {
      if (onDone) onDone(ok);
      label.textContent = ok ? "Copied" : "Copy failed";
      setTimeout(function () { label.textContent = label.getAttribute("data-label"); }, 1600);
    };
    var fallback = function () {
      var ok = false;
      try {
        var ta = document.createElement("textarea");
        ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
        button.parentNode.appendChild(ta); ta.select();
        ok = document.execCommand("copy");
        ta.remove();
      } catch (e) {}
      button.focus();
      done(ok);
    };
    try {
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    } catch (e) { fallback(); }
  }

  /* The install panel: copy buttons, and the part to show for "Get relay". */
  var install = document.getElementById("install");
  var copyStatus = document.getElementById("copy-status");
  install.querySelectorAll("[data-copy]").forEach(function (button) {
    button.addEventListener("click", function () {
      var pre = document.getElementById(button.getAttribute("data-copy"));
      copyText(pre.textContent + "\n", button, button, function (ok) {
        copyStatus.textContent = ok ? "Commands copied." : "Copying failed. Select the commands and copy them by hand.";
      });
    });
  });
  var focusOnOpen = null;
  document.querySelectorAll('[popovertarget="install"]').forEach(function (button) {
    button.addEventListener("click", function () { focusOnOpen = button.getAttribute("data-install-focus"); });
  });
  install.addEventListener("toggle", function (event) {
    if (event.newState !== "open" || !focusOnOpen) return;
    var target = document.getElementById(focusOnOpen);
    focusOnOpen = null;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "start" });
  });
})();
