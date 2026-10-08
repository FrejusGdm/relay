import { expect, type Page, test as base } from "@playwright/test";
import path from "node:path";

const target = process.env.SITE_URL ? "live" : "local";
const widths = [1440, 1024, 390];

type Problem = { text: string; url: string };

// Every test collects console errors, page errors and Content-Security-Policy violations,
// and fails if any is left when it ends.
const test = base.extend<{ problems: Problem[] }>({
  problems: [
    async ({ page }, use) => {
      const problems: Problem[] = [];
      await page.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (event) => {
          console.error(`Content-Security-Policy violation: ${event.violatedDirective} blocked ${event.blockedURI}`);
        });
      });
      page.on("console", (message) => {
        if (message.type() === "error") problems.push({ text: message.text(), url: message.location().url });
      });
      page.on("pageerror", (error) => problems.push({ text: error.message, url: page.url() }));
      await use(problems);
      expect(problems).toEqual([]);
    },
    { auto: true },
  ],
});

// Lists every element that sticks out of the window sideways, or out of an ancestor that clips it.
const overflowCheck = () => {
  const vw = document.documentElement.clientWidth;
  const problems: string[] = [];
  if (document.documentElement.scrollWidth > vw) problems.push(`page is ${document.documentElement.scrollWidth}px wide`);
  const name = (el: Element) => `${el.tagName.toLowerCase()}.${(el as HTMLElement).className}`;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
    if (el.closest(".map, .sr-only, template, dialog:not([open]), [popover]:not(:popover-open)")) continue;
    if (el.closest(".doc") && vw > 520) continue; // the checkpoint document bleeds out of its cell on purpose
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // Horizontal: the window, or the nearest ancestor that clips sideways.
    let clip = el.parentElement;
    while (clip && clip !== document.body && getComputedStyle(clip).overflowX === "visible") clip = clip.parentElement;
    const xScrolls = clip && clip !== document.body && ["auto", "scroll"].includes(getComputedStyle(clip).overflowX);
    const xBox = clip && clip !== document.body ? clip.getBoundingClientRect() : { left: 0, right: vw };
    if (!xScrolls && (r.left < xBox.left - 1 || r.right > xBox.right + 1)) {
      problems.push(`${name(el)} spans x ${Math.round(r.left)}..${Math.round(r.right)}, its box is ${Math.round(xBox.left)}..${Math.round(xBox.right)}`);
    }
    // Vertical: only an ancestor that clips; the page itself scrolls down normally.
    let vclip = el.parentElement;
    while (vclip && vclip !== document.body && getComputedStyle(vclip).overflowY === "visible") vclip = vclip.parentElement;
    if (vclip && vclip !== document.body && !["auto", "scroll"].includes(getComputedStyle(vclip).overflowY)) {
      const yBox = vclip.getBoundingClientRect();
      if (r.top < yBox.top - 1 || r.bottom > yBox.bottom + 1) {
        problems.push(`${name(el)} spans y ${Math.round(r.top)}..${Math.round(r.bottom)}, ${name(vclip)} clips at ${Math.round(yBox.top)}..${Math.round(yBox.bottom)}`);
      }
    }
  }
  return problems;
};

for (const width of widths) {
  test.describe(`with reduced motion at ${width} pixels`, () => {
    test.use({ viewport: { width, height: 900 }, reducedMotion: "reduce", colorScheme: "light" });

    test(`fits at ${width} pixels`, async ({ page }) => {
      await page.goto("/");
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      expect(await page.evaluate(() => document.fonts.check("500 40px Satoshi"))).toBe(true);

      expect(await page.evaluate(overflowCheck)).toEqual([]);

      await expect(page.locator(".hero .map, .hero svg line")).toHaveCount(0);
      await expect(page.locator("#terminal")).toHaveCount(0);

      const padTop = await page.locator("#cost").evaluate((el) => getComputedStyle(el).paddingTop);
      const padSide = await page.locator("#cost .wrap").evaluate((el) => getComputedStyle(el).paddingLeft);
      if (width === 390) expect([padTop, padSide]).toEqual(["96px", "16px"]);
      if (width === 1440) expect([padTop, padSide]).toEqual(["128px", "24px"]);

      await expect(page.locator('[data-rc="note"]')).toHaveText("Illustrated manual handoff · reduced motion");
      await expect(page.locator('[data-rc="codex-role"]')).toHaveText("Current worker");
      await expect(page.locator('[data-rc="codex-state"]')).toHaveText("Working");

      await page.screenshot({ path: path.join(import.meta.dirname, "out", `${target}-${width}.png`), fullPage: true });
    });
  });

  test.describe(`with motion at ${width} pixels`, () => {
    test.use({ viewport: { width, height: 900 }, reducedMotion: "no-preference" });

    test(`does not scroll sideways while the story plays at ${width} pixels`, async ({ page }) => {
      await page.goto("/");
      for (let i = 0; i < 16; i++) {
        const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
        expect(fits, `page width at ${i * 500} ms`).toBe(true);
        await page.waitForTimeout(500);
      }
    });
  });
}

const macosBlock = [
  'mkdir -p "$HOME/.local/bin"',
  'curl -fsSL -o "$HOME/.local/bin/relay" \\',
  "  https://github.com/FrejusGdm/relay/releases/latest/download/relay-darwin-arm64",
  'chmod +x "$HOME/.local/bin/relay"',
  '"$HOME/.local/bin/relay" --version',
].join("\n");

for (const width of widths) {
  test.describe(`install panel opened at ${width} pixels`, () => {
    test.use({ viewport: { width, height: 900 }, reducedMotion: "reduce", colorScheme: "light" });

    test(`install panel at ${width} pixels`, async ({ page, context }) => {
      await page.goto("/");
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const panel = page.locator("#install");
      await page.locator("#story").getByRole("button", { name: "CLI setup" }).click();
      await expect(panel).toBeVisible();
      expect(await panel.evaluate((el) => el.matches(":popover-open"))).toBe(true);

      const box = await panel.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, width: document.documentElement.clientWidth };
      });
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(box.width);
      const fits = await page.locator(".install-cmd").evaluateAll((els) => els.map((el) => el.scrollWidth <= el.clientWidth));
      expect(fits).toEqual([true, true]);
      await page.screenshot({ path: path.join(import.meta.dirname, "out", `${target}-install-${width}.png`) });

      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const copy = panel.getByRole("button", { name: "Copy the macOS commands" });
      await copy.click();
      await expect(copy).toHaveText("Copied");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${macosBlock}\n`);

      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
    });
  });
}

test.describe("at 1024 by 700 pixels", () => {
  test.use({ viewport: { width: 1024, height: 700 } });

  test("Get relay shows the macOS command-line commands", async ({ page }) => {
    await page.goto("/");
    await page.locator("#story").getByRole("button", { name: "Get relay", exact: true }).click();
    await expect(page.locator("#install-macos")).toBeFocused();
    const visible = await page.evaluate(() => {
      const panel = document.getElementById("install")!.getBoundingClientRect();
      const heading = document.getElementById("install-macos")!.getBoundingClientRect();
      return heading.top >= panel.top && heading.bottom <= panel.bottom;
    });
    expect(visible).toBe(true);
  });

  test("the Mac app block has no command and says it is not released yet", async ({ page }) => {
    await page.goto("/");
    await page.locator("#story").getByRole("button", { name: "CLI setup" }).click();
    const block = page.locator(".install-block").filter({ has: page.locator("#install-mac") });
    await expect(block).toContainText("The Mac menu-bar app is not released yet. The command line tool above works on its own.");
    await expect(block.locator("pre, [data-copy]")).toHaveCount(0);
  });
});

const lightBackground = "rgb(244, 242, 236)";
const darkBackground = "rgb(13, 13, 12)";
const expectBackground = (page: Page, color: string) => expect(page.locator("body")).toHaveCSS("background-color", color);
const themeToggle = (page: Page) => page.locator("nav.site-nav #theme-toggle");
const backgroundOf = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => getComputedStyle(el).backgroundColor);

// Records the theme on <html> at the moment <body> is created, which is before the first paint.
const recordThemeAtBody = () => {
  new MutationObserver((_, observer) => {
    if (!document.body) return;
    (window as unknown as { themeAtBody: string | null }).themeAtBody = document.documentElement.getAttribute("data-theme");
    observer.disconnect();
  }).observe(document, { childList: true, subtree: true });
};
const themeAtBody = (page: Page) => page.evaluate(() => (window as unknown as { themeAtBody: string | null }).themeAtBody);

const expectToggleOffers = async (page: Page, next: "dark" | "light") => {
  await expect(themeToggle(page)).toHaveAttribute("aria-label", `Switch to ${next} theme`);
  await expect(themeToggle(page).locator(next === "dark" ? ".icon-moon" : ".icon-sun")).toBeVisible();
  await expect(themeToggle(page).locator(next === "dark" ? ".icon-sun" : ".icon-moon")).toBeHidden();
};

test.describe("theme button in a dark system theme", () => {
  test.use({ colorScheme: "dark" });

  test("the page is light by default and the button offers the dark theme", async ({ page }) => {
    await page.goto("/");
    await expectBackground(page, lightBackground);
    await expectToggleOffers(page, "dark");
  });

  test("the button switches the theme, and the choice survives a reload without a wrong first paint", async ({ page, problems }) => {
    await page.addInitScript(recordThemeAtBody);
    await page.goto("/");
    await themeToggle(page).click();
    await expectBackground(page, darkBackground);
    await expectToggleOffers(page, "light");

    await page.reload();
    expect(await themeAtBody(page)).toBe("dark");
    await expectBackground(page, darkBackground);
    await expectToggleOffers(page, "light");

    await page.goto("/no-such-page");
    await expectBackground(page, darkBackground);
    const own = problems.findIndex((p) => p.url === page.url() && p.text.includes("status of 404"));
    if (own >= 0) problems.splice(own, 1);

    await page.goto("/");
    await themeToggle(page).click();
    await expectBackground(page, lightBackground);
    await page.reload();
    expect(await themeAtBody(page)).toBe("light");
    await expectBackground(page, lightBackground);
    await expectToggleOffers(page, "dark");
  });

  test("the button works from the keyboard, shows focus and is 32 to 36 pixels square", async ({ page }) => {
    await page.goto("/");
    await page.locator("nav.site-nav .nav-link").focus();
    await page.keyboard.press("Tab");
    const toggle = themeToggle(page);
    await expect(toggle).toBeFocused();
    expect(await toggle.evaluate((el) => el.matches(":focus-visible") && getComputedStyle(el).outlineStyle)).toBe("solid");
    const box = (await toggle.boundingBox())!;
    for (const side of [box.width, box.height]) {
      expect(side).toBeGreaterThanOrEqual(32);
      expect(side).toBeLessThanOrEqual(36);
    }
    await page.keyboard.press("Enter");
    await expectBackground(page, darkBackground);
    await expectToggleOffers(page, "light");
  });

  test("the button works when the browser blocks storage", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new DOMException("Storage is blocked", "SecurityError");
        },
      });
    });
    await page.goto("/");
    await expectBackground(page, lightBackground);
    await themeToggle(page).click();
    await expectBackground(page, darkBackground);
    await page.reload();
    await expectBackground(page, lightBackground);
  });
});

for (const width of widths) {
  test.describe(`header at ${width} pixels`, () => {
    test.use({ viewport: { width, height: 900 }, reducedMotion: "reduce", colorScheme: "dark" });

    test(`header and hero in both themes at ${width} pixels`, async ({ page }) => {
      await page.goto("/");
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await expect(themeToggle(page)).toBeVisible();
      const box = await themeToggle(page).evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, width: document.documentElement.clientWidth };
      });
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(box.width);
      // The navigation's Get relay is the olive primary button, like the hero's.
      expect(await backgroundOf(page, "nav.site-nav .btn-primary")).toBe("rgb(82, 97, 58)");
      expect(await backgroundOf(page, "#story .ctas .btn-primary")).toBe("rgb(82, 97, 58)");
      expect(await page.evaluate(overflowCheck)).toEqual([]);
      await page.screenshot({ path: path.join(import.meta.dirname, "out", `${target}-theme-light-${width}.png`) });

      await themeToggle(page).click();
      await page.mouse.move(0, 0); // the screenshot shows the button at rest, not hovered
      await expectBackground(page, darkBackground);
      expect(await backgroundOf(page, "nav.site-nav .btn-primary")).toBe("rgb(189, 205, 160)");
      expect(await backgroundOf(page, "#story .ctas .btn-primary")).toBe("rgb(189, 205, 160)");
      expect(await page.evaluate(overflowCheck)).toEqual([]);
      await page.screenshot({ path: path.join(import.meta.dirname, "out", `${target}-theme-dark-${width}.png`) });
    });
  });
}

test("card dialogs open and close", async ({ page }) => {
  await page.goto("/");
  const dialog = page.locator('#hero-card [data-rc-dialog="checkpoint"]');
  await page.locator("#hero-card").getByRole("button", { name: "View checkpoint" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
});

test("unknown address shows the 404 page", async ({ page, problems }) => {
  const response = await page.goto("/no-such-page");
  expect(response?.status()).toBe(404);
  await expect(page.locator("h1")).toHaveText("Page not found");
  // Chromium reports the 404 answer of the page itself as a console error; only that one message is expected.
  const own = problems.findIndex((p) => p.url === page.url() && p.text.includes("status of 404"));
  if (own >= 0) problems.splice(own, 1);
});

// The task graph's connectors start and end at the tasks' ports: the middle of the right and left
// sides in the wide layout, the middle of the bottom and top in the narrow one.
for (const width of [1440, 1024, 390]) {
  test(`task graph connectors meet the ports at ${width} pixels`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.locator("#tg").scrollIntoViewIfNeeded();
    const result = await page.evaluate(() => {
      const tg = document.getElementById("tg")!;
      const base = tg.getBoundingClientRect();
      const vertical = tg.classList.contains("vertical");
      const box = (id: string) => document.querySelector(`.tg-node[data-node="${id}"]`)!.getBoundingClientRect();
      const misses: string[] = [];
      const paths = Array.from(document.querySelectorAll<SVGPathElement>("#tg-edges path"));
      for (const path of paths) {
        const from = box(path.dataset.from!), to = box(path.dataset.to!);
        const start = path.getPointAtLength(0), end = path.getPointAtLength(path.getTotalLength());
        const want = vertical
          ? [from.left + from.width / 2, from.bottom, to.left + to.width / 2, to.top]
          : [from.right, from.top + from.height / 2, to.left, to.top + to.height / 2];
        const got = [start.x + base.left, start.y + base.top, end.x + base.left, end.y + base.top];
        if (got.some((v, i) => Math.abs(v - want[i]!) > 1)) misses.push(`${path.dataset.from}→${path.dataset.to}`);
      }
      return { count: paths.length, vertical, misses };
    });
    expect(result.count).toBe(11);
    expect(result.vertical).toBe(width < 900);
    expect(result.misses).toEqual([]);
  });
}

test("a task can be selected from the keyboard to highlight its connections", async ({ page }) => {
  await page.goto("/");
  const task = page.locator('.tg-node[data-node="cb"]');
  await task.focus();
  await page.keyboard.press("Enter");
  await expect(task).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#tg-edges .focused-edge")).toHaveCount(3);
  await expect(page.locator(".tg-node.related-node")).toHaveCount(3);
  await expect(page.locator("#tg-announce")).toHaveText("Callback route depends on Plan the job. Callback tests and Token refresh depend on it.");
  await page.keyboard.press("Space");
  await expect(task).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#tg-edges .focused-edge")).toHaveCount(0);
  await expect(page.locator("#tg-announce")).toHaveText("No task selected.");
});

test("the task graph plays once, holds its last moment, and can be paused and replayed", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  await page.locator(".tg-fig").scrollIntoViewIfNeeded();
  const moment = (n: number) => page.locator(`#tg-phase > [data-ph="${n}"]`);
  const pause = page.locator("#tg-pause");
  await expect(pause).toBeEnabled();
  await page.clock.runFor(8000);
  await expect(moment(1)).toHaveCSS("opacity", "1");
  await expect(page.locator(".tg-node.is-paused")).toHaveCount(4);
  await page.clock.runFor(5000);
  await expect(moment(2)).toHaveCSS("opacity", "1");
  await expect(page.locator(".tg-node.is-paused")).toHaveCount(0);
  await expect(pause).toBeDisabled();
  await page.clock.runFor(30000);
  await expect(moment(2)).toHaveCSS("opacity", "1");

  await page.locator("#tg-replay").click();
  await expect(moment(0)).toHaveCSS("opacity", "1");
  await pause.click();
  await expect(pause).toHaveText("Resume");
  await page.clock.runFor(10000);
  await expect(moment(0)).toHaveCSS("opacity", "1");
  await pause.click();
  await page.clock.runFor(12000);
  await expect(moment(2)).toHaveCSS("opacity", "1");
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the hero and the task graph show their last state", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#hero-card .rc")).toHaveAttribute("data-step", "5");
    await expect(page.locator('[data-rc="drawing-hash"]')).toHaveText("912ec1");
    await expect(page.locator('#tg-phase > [data-ph="2"]')).toHaveCSS("opacity", "1");
    await expect(page.locator("#tg-pause")).toBeDisabled();
  });
});

test("every provider logo loads, and the monochrome ones are inverted in the dark theme", async ({ page }) => {
  await page.goto("/");
  const logos = page.locator("img.brand-mark");
  await expect(logos).toHaveCount(3 + 2 + 2 + 9);
  for (const img of await logos.all()) {
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  }
  await themeToggle(page).click();
  expect(await page.locator(".providers .brand-mono").first().evaluate((el) => getComputedStyle(el).filter)).toBe("invert(1)");
  expect(await page.locator(".providers .brand-mark:not(.brand-mono)").evaluate((el) => getComputedStyle(el).filter)).toBe("none");
  await expect(page.locator("#hero-card .rc-logo.for-dark")).toBeVisible();
  await expect(page.locator("#hero-card .rc-logo.for-light")).toBeHidden();
});
