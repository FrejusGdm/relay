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
     The returned setInView(bool) pauses it off screen. */
  function mountRelayCard(host) {
    host.appendChild(document.getElementById("card-tpl").content.cloneNode(true));
    var root = host.querySelector(".rc");
    var $ = function (n) { return root.querySelector('[data-rc="' + n + '"]'); };
    var reducedQ = window.matchMedia("(prefers-reduced-motion: reduce)");
    var DURATION = 7200;
    var stages = [
      { at: 0, line: "<strong>Claude Code is working</strong> · building authentication", claude: "Working", codex: "Ready", caption: "<b>Next worker: Codex</b>Same repository &amp; plan", active: "claude" },
      { at: 1300, line: "<strong>Claude Code is working</strong> · usage running out", claude: "Usage running out", codex: "Ready", caption: "<b>Next worker: Codex</b>Same repository &amp; plan", active: "claude" },
      { at: 2600, line: "<strong>Limit reached</strong> · resets <time>18:00</time>", claude: "Limit reached", codex: "Ready", caption: "<b>Waiting for your manual switch</b>Next worker: Codex", active: "" },
      { at: 3700, line: "<strong>Saving checkpoint</strong> · keeping the repository &amp; plan", claude: "Limit · resets <time>18:00</time>", codex: "Ready", caption: "<b>Saving the work before switching</b>Checkpoint + plan", active: "" },
      { at: 4800, line: "<strong>Moving the job to Codex</strong> · manual switch", claude: "Limit · resets <time>18:00</time>", codex: "Receiving work", caption: '<b>Manual switch · <time>14:19</time></b>Moving checkpoint <span class="mono">912ec1</span> + plan', active: "codex" },
      { at: 6000, line: "<strong>Moved to Codex</strong> · Claude Code reached its limit", claude: "Limit · resets <time>18:00</time>", codex: "Working", caption: '<b>Handed off manually · <time>14:19</time></b>at checkpoint <span class="mono">912ec1</span>', active: "codex" }
    ];
    var elapsed = 0, lastTime = 0, raf = 0, index = -1, paused = false, inView = false, running = false, animations = [];
    var ease = "cubic-bezier(0.22, 1, 0.36, 1)";
    var pauseBtn = $("pause");
    function entrance(el) {
      if (reducedQ.matches) return;
      animations.push(el.animate([{ opacity: 0, transform: "translateY(3px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 220, easing: ease }));
    }
    function render(i, animate) {
      index = i;
      var s = stages[i];
      $("line").innerHTML = s.line;
      $("claude-state").innerHTML = s.claude;
      $("codex-state").textContent = s.codex;
      $("transfer").innerHTML = s.caption;
      $("claude").classList.toggle("active", s.active === "claude");
      $("codex").classList.toggle("active", s.active === "codex");
      $("claude-role").textContent = i < 2 ? "Current worker" : "Previous worker";
      $("codex-role").textContent = i < 4 ? "Next worker" : "Current worker";
      $("claude-state").className = "rc-state " + (i < 2 ? "working" : "warning");
      $("codex-state").className = "rc-state" + (i >= 4 ? " working" : "");
      $("hash").textContent = i < 3 ? "8f4a20" : i === 3 ? "Saving…" : "912ec1";
      $("saved").innerHTML = i < 3 ? "· previous" : i === 3 ? "" : "· saved <time>14:19</time>";
      $("open-label").textContent = i < 4 ? "Open Claude Code" : "Open Codex";
      if (animate) entrance($("line"));
      if (i === 1 && animate && !reducedQ.matches) animations.push($("fill").animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], { duration: 1300, easing: ease, fill: "forwards" }));
      $("fill").style.transform = i >= 2 ? "scaleX(0)" : (i === 0 ? "scaleX(1)" : $("fill").style.transform);
      if (i === 4 && animate && !reducedQ.matches) {
        animations.push($("token").animate([
          { opacity: 0, transform: "translateY(0)" }, { opacity: 1, transform: "translateY(6px)", offset: 0.15 },
          { opacity: 1, transform: "translateY(44px)", offset: 0.8 }, { opacity: 0, transform: "translateY(49px)" }
        ], { duration: 1100, easing: ease }));
      }
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
  /* Task graph */
  var tg = document.getElementById("tg");
  var tgEdges = document.getElementById("tg-edges");
  var tgDots = document.getElementById("tg-dots");
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
  var nodeEl = {};
  NODES.forEach(function (n) {
    var d = document.createElement("div");
    d.className = "tg-node " + n.p;
    d.style.setProperty("--dc", n.dc); d.style.setProperty("--dr", n.dr);
    d.style.setProperty("--mc", n.mc); d.style.setProperty("--mr", n.mr);
    var paus = PAUSABLE.indexOf(n.id) > -1;
    d.innerHTML = '<div class="nt"></div><div class="nm2"><span class="pv">' + (n.p === "claude" ? "Claude" : "Codex") + '</span><span class="stack sw2"><span class="w"></span>' + (paus ? '<span class="p">Paused</span>' : "") + '</span></div>';
    d.querySelector(".nt").textContent = n.t;
    d.querySelector(".w").textContent = n.s;
    tg.appendChild(d);
    nodeEl[n.id] = d;
  });
  var provOf = {};
  NODES.forEach(function (n) { provOf[n.id] = n.p; });
  var dotList = [];
  var tgVisible = false, phase = 0, tClock = 0;

  function edgePaused(e) { return phase === 1 && (PAUSABLE.indexOf(e[0]) > -1 || PAUSABLE.indexOf(e[1]) > -1); }

  function layoutGraph() {
    var vertical = tg.clientWidth < 700;
    tg.classList.toggle("vertical", vertical);
    var W = tg.clientWidth, H = tg.clientHeight;
    tgEdges.setAttribute("viewBox", "0 0 " + W + " " + H);
    while (tgEdges.firstChild) tgEdges.removeChild(tgEdges.firstChild);
    dotList.forEach(function (d) { d.a1.cancel(); d.a2.cancel(); d.wrap.remove(); });
    dotList = [];
    EDGES.forEach(function (e, idx) {
      var a = rel(nodeEl[e[0]], tg), b = rel(nodeEl[e[1]], tg);
      var x1, y1, x2, y2, pts;
      if (!vertical) {
        x1 = Math.round(a.right); y1 = half(a.top + a.height / 2);
        x2 = Math.round(b.left); y2 = half(b.top + b.height / 2);
        var xm = half((x1 + x2) / 2);
        pts = [[x1, y1], [xm, y1], [xm, y2], [x2, y2]];
      } else {
        x1 = half(a.left + a.width / 2); y1 = Math.round(a.bottom);
        x2 = half(b.left + b.width / 2); y2 = Math.round(b.top);
        var ym = half((y1 + y2) / 2);
        pts = [[x1, y1], [x1, ym], [x2, ym], [x2, y2]];
      }
      svgEl("path", { d: "M" + pts.map(function (p) { return p[0] + " " + p[1]; }).join(" L"), "shape-rendering": "crispEdges" }, tgEdges);
      if (reduce) return;
      var lens = [0], total = 0;
      for (var i = 1; i < pts.length; i++) { total += Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]); lens.push(total); }
      var span = 0.72;
      var frames = pts.map(function (p, i) {
        return { transform: "translate(" + (p[0] - x1) + "px," + (p[1] - y1) + "px)", offset: total ? (lens[i] / total) * span : 0 };
      });
      frames.push({ transform: frames[frames.length - 1].transform, offset: 1 });
      for (var k = 1; k < frames.length; k++) if (frames[k].offset < frames[k - 1].offset) frames[k].offset = frames[k - 1].offset;
      var wrap = document.createElement("span");
      wrap.className = "dw";
      wrap.style.left = x1 + "px"; wrap.style.top = y1 + "px";
      var mover = document.createElement("span");
      mover.style.display = "block";
      var dot = document.createElement("i");
      dot.className = "dot " + provOf[e[0]];
      mover.appendChild(dot); wrap.appendChild(mover); tgDots.appendChild(wrap);
      var opts = { duration: 2800, iterations: Infinity, delay: (idx % 4) * 450 + Math.floor(idx / 4) * 260, easing: "linear" };
      var a1 = mover.animate(frames, opts);
      var a2 = dot.animate([
        { opacity: 0, offset: 0 }, { opacity: 1, offset: 0.06 }, { opacity: 1, offset: span - 0.06 }, { opacity: 0, offset: span }, { opacity: 0, offset: 1 }
      ], opts);
      var rec = { e: e, wrap: wrap, a1: a1, a2: a2 };
      dotList.push(rec);
      syncDot(rec);
    });
  }
  function syncDot(d) {
    var stop = edgePaused(d.e) || !tgVisible;
    d.wrap.classList.toggle("off", edgePaused(d.e));
    if (stop) { d.a1.pause(); d.a2.pause(); } else { d.a1.play(); d.a2.play(); }
  }
  function setPhase(p) {
    phase = p;
    document.querySelectorAll("#tg-phase > span, #tg-clock > span").forEach(function (s) { s.style.opacity = Number(s.dataset.ph) === p ? "1" : "0"; });
    PAUSABLE.forEach(function (id) { nodeEl[id].classList.toggle("is-paused", p === 1); });
    dotList.forEach(syncDot);
  }
  var tgFig = document.querySelector(".tg-fig");
  if (reduce) {
    document.getElementById("tg-caption").textContent = "Illustrated. The first release switches one job at a time. Motion is reduced, so the graph is still.";
  } else {
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { tgVisible = e.isIntersecting; dotList.forEach(syncDot); });
      }, { threshold: 0.15 }).observe(tgFig);
    } else { tgVisible = true; }
    setInterval(function () {
      if (!tgVisible || document.hidden) return;
      tClock = (tClock + 0.25) % 15;
      var p = tClock < 7 ? 0 : (tClock < 11.5 ? 1 : 2);
      if (p !== phase) setPhase(p);
    }, 250);
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
