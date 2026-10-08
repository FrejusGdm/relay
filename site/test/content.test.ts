import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const pub = join(import.meta.dir, "..", "public");
const read = (name: string) => Bun.file(join(pub, name)).text();
const htmlFiles = readdirSync(pub, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".html") && !name.startsWith("fonts/"));
const allowedLinks = ["#top", "#how", "#pricing", "/", "https://www.apache.org/licenses/LICENSE-2.0", "https://github.com/FrejusGdm/relay"];

describe.each(htmlFiles)("%s", (name) => {
  test("links only to parts of the page, the home page and the license", async () => {
    const html = await read(name);
    const links = [...html.matchAll(/<a\b[^>]*\shref="([^"]*)"/gi)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(allowedLinks).toContain(link);
  });
});

describe("index.html", () => {
  test("does not use the word preview", async () => {
    expect(await read("index.html")).not.toMatch(/preview/i);
  });

  test("has none of the preview's controls or reference sections", async () => {
    expect(await read("index.html")).not.toMatch(/class="[^"]*\b(topbar|tokens)\b/);
  });

  test("has its sections in the designed order", async () => {
    const ids = [...(await read("index.html")).matchAll(/<section\b[^>]*\sid="([^"]*)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["cost", "how", "graph", "pricing", "closing"]);
  });

  test("has the designed headline and title", async () => {
    const html = await read("index.html");
    const headings = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => m[1]);
    expect(headings).toEqual(["Never run out of limits again."]);
    expect(html).toContain("<title>relay: never run out of limits again</title>");
  });

  test("says that paid features will be a one-time payment for a lifetime license", async () => {
    const pricing = (await read("index.html")).match(/<section id="pricing">[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(pricing).toContain("one-time payment");
    expect(pricing).toContain("lifetime license");
  });

  test("names no price and has no checkout: buying is off unless site/scripts/build.sh turns it on", async () => {
    const html = await read("index.html");
    expect(html).not.toMatch(/\$\d/);
    expect(html).not.toMatch(/checkout|stripe|buy now|donat/i);
  });

  test("has one theme button in the navigation, with a moon and a sun icon, that offers the dark theme", async () => {
    const nav = (await read("index.html")).match(/<nav class="site-nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
    const buttons = nav.match(/<button\b[^>]*\bid="theme-toggle"[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons.length).toBe(1);
    const button = buttons[0]!;
    expect(button).toContain('aria-label="Switch to dark theme"');
    expect(button).toContain('<svg class="icon-moon" viewBox="0 0 20 20" aria-hidden="true">');
    expect(button).toContain('<svg class="icon-sun" viewBox="0 0 20 20" aria-hidden="true">');
    expect(nav).not.toMatch(/data-theme-choice|role="group"/);
  });

  test("shows Get relay in the navigation as the olive primary button", async () => {
    const nav = (await read("index.html")).match(/<nav class="site-nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(nav).toContain('<button type="button" class="btn btn-primary btn-sm" popovertarget="install">Get relay</button>');
  });

  test("has no track lines in the hero and no terminal section", async () => {
    const html = await read("index.html");
    const hero = html.match(/<div class="hero" id="story">[\s\S]*?<!-- Provider row -->/)?.[0] ?? "";
    expect(hero).toContain('<div id="hero-card"></div>');
    expect(hero).not.toMatch(/class="map"|<line\b|hero-svg/);
    expect(html).not.toMatch(/id="terminal"|Switch from the terminal|relay switch codex:personal|copy-btn/);
    expect(await read("styles.css")).not.toMatch(/\.(term|story|seg)(?![\w-])|\.(term|m)-|--trail/);
    expect(await read("site.js")).not.toMatch(/copy-btn|hero-svg|hero-map|layoutHero/);
  });

  test("names every tool in the providers row, with the real logo beside the ones that have one", async () => {
    const row = (await read("index.html")).match(/<div class="providers">[\s\S]*?<\/ul>/)?.[0] ?? "";
    for (const name of ["Claude Code", "Codex", "Cursor", "T3 Code", "OpenCode"]) expect(row).toContain(name);
    expect(row).not.toMatch(/<svg/);
    const logos = [...row.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    expect(logos.map((tag) => tag.match(/src="([^"]*)"/)?.[1])).toEqual(["/logos/claude.svg", "/logos/openai.svg", "/logos/cursor.svg"]);
    for (const tag of logos) expect(tag).toContain('alt=""');
  });

  test("serves the provider logos as unchanged copies of docs/design/animation-assets", async () => {
    const assets = join(import.meta.dir, "..", "..", "docs", "design", "animation-assets");
    for (const name of ["claude.svg", "cursor.svg"]) expect(await read(join("logos", name))).toBe(await Bun.file(join(assets, name)).text());
    // openai.svg differs only in its viewBox, tightened to the mark so it looks as large as the others.
    const original = await Bun.file(join(assets, "openai.svg")).text();
    expect(await read("logos/openai.svg")).toBe(original.replace('viewBox="0 0 721 721"', 'viewBox="118.557 119.958 484.139 479.818"'));
    // openai-dark.svg is the same mark in white, for the dark theme inside the hero's SVG drawing.
    expect(await read("logos/openai-dark.svg")).toBe((await read("logos/openai.svg")).replace('fill="black"', 'fill="white"'));
  });

  test("keeps every event and time of the time comparison", async () => {
    const cost = (await read("index.html")).match(/<section id="cost">[\s\S]*?<\/section>/)?.[0] ?? "";
    const times = [...cost.matchAll(/<li class="ev[^"]*"><time>([^<]*)<\/time>/g)].map((m) => m[1]);
    expect(times).toEqual(["14:19", "14:31", "14:34", "14:38", "14:52", "15:05", "14:19", "14:19", "14:20", "15:05"]);
  });

  test("has only forms that close a dialog", async () => {
    const forms = (await read("index.html")).match(/<form\b[^>]*>/gi) ?? [];
    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) expect(form).toContain('method="dialog"');
  });
});

describe("license/index.html", () => {
  test("has the texts of every state and loads only its own script", async () => {
    const html = await read("license/index.html");
    expect(html).toContain("<noscript><p>This page needs JavaScript to show your key.</p></noscript>");
    expect(html).toContain('<h1 class="display">Your relay license</h1>');
    expect(html).toContain(">Copy key</button>");
    expect(html).toContain(">Copy command</button>");
    expect(html).toContain("Activate it in a terminal:");
    expect(html).toContain(
      "Save this key somewhere safe. relay checks it on your computer and never sends it anywhere. This page shows the same key again if you open it later.",
    );
    expect(html).toContain('<script src="/license/license.js" defer></script>');
    const js = await read("license/license.js");
    for (const text of [
      "Getting your license key…",
      "Your payment is still processing. Your key appears on this page when the payment completes. Reload it later.",
      "This link does not lead to a paid order. If you paid, write to the support address on your Stripe receipt.",
      "Something went wrong on our side. Nothing was charged twice. Reload this page in a minute.",
    ]) {
      expect(js).toContain(text);
    }
  });
});

test("robots.txt asks every crawler to stay away", async () => {
  expect(await read("robots.txt")).toBe("User-agent: *\nDisallow: /\n");
});

test("404.html says the page was not found", async () => {
  expect(await read("404.html")).toContain("Page not found");
});
