import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const site = join(import.meta.dir, "..");
const pub = join(site, "public");
const read = (path: string) => Bun.file(path).text();
const htmlFiles = readdirSync(pub).filter((name) => name.endsWith(".html"));
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe.each(htmlFiles)("%s", (name) => {
  test("has no inline style, inline script or event-handler attribute", async () => {
    const html = await read(join(pub, name));
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) expect(tag).toMatch(/\ssrc=/i);
  });

  test("loads every script, image and stylesheet from the site itself", async () => {
    const html = await read(join(pub, name));
    const sources = [...html.matchAll(/\ssrc="([^"]*)"/gi)].map((m) => m[1]!);
    const links = [...html.matchAll(/<link\b[^>]*\shref="([^"]*)"/gi)].map((m) => m[1]!);
    expect(sources.length + links.length).toBeGreaterThan(0);
    for (const url of [...sources, ...links]) {
      expect(url.startsWith("/")).toBe(true);
      expect(url.startsWith("//")).toBe(false);
    }
  });
});

describe("styles.css", () => {
  test("imports nothing and names no other server", async () => {
    const css = stripComments(await read(join(pub, "styles.css")));
    expect(css).not.toMatch(/@import/i);
    expect(css).not.toMatch(/http/i);
  });

  test("loads only the fonts listed in site/fonts.sha256", async () => {
    const css = stripComments(await read(join(pub, "styles.css")));
    const listed = (await read(join(site, "fonts.sha256"))).trim().split("\n").map((line) => line.split(/\s+/)[1]);
    const urls = [...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]!);
    expect(urls.length).toBe(6);
    for (const url of urls) {
      const match = url.match(/^"\/fonts\/([A-Za-z0-9-]+\.woff2)"$/);
      expect(match).not.toBeNull();
      expect(listed).toContain(match![1]);
    }
  });

  test("keeps the license address in the font comment", async () => {
    expect(await read(join(pub, "styles.css"))).toContain("https://openfontlicense.org");
  });

  test("does not hide overflow on html or body", async () => {
    const css = stripComments(await read(join(pub, "styles.css")));
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = rule[1]!.split(",").map((s) => s.trim());
      if (!selectors.some((s) => s === "html" || s === "body")) continue;
      expect(rule[2]).not.toMatch(/overflow(-x)?\s*:\s*hidden/);
    }
  });
});

describe("site.js", () => {
  const forbidden = [
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "document.cookie",
    "fetch(",
    "XMLHttpRequest",
    "sendBeacon",
    "WebSocket",
    "EventSource",
    "eval(",
    "new Function",
    "style=",
    "https://",
  ];

  test.each(forbidden)("does not contain %s", async (text) => {
    expect(await read(join(pub, "site.js"))).not.toContain(text);
  });

  test("names no address except the SVG namespace", async () => {
    const js = await read(join(pub, "site.js"));
    expect(js.match(/http:\/\/[^"'\s]*/g)).toEqual(["http://www.w3.org/2000/svg"]);
  });
});

describe("github.js", () => {
  const forbidden = ["sessionStorage", "indexedDB", "document.cookie", "XMLHttpRequest", "sendBeacon", "WebSocket", "EventSource", "eval(", "new Function", "innerHTML", "style"];

  test.each(forbidden)("does not contain %s", async (text) => {
    const js = (await read(join(pub, "github.js"))).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(js).not.toContain(text);
  });

  test("asks only GitHub's API for relay's repository, without cookies or referrer", async () => {
    const js = await read(join(pub, "github.js"));
    expect(js.match(/https?:\/\/[^"'\s]*/g)).toEqual(["https://api.github.com/repos/FrejusGdm/relay"]);
    expect(js.match(/fetch\([^)]*\)/g)).toEqual(['fetch(API, { credentials: "omit", referrerPolicy: "no-referrer" })']);
  });

  test("reads and writes localStorage only inside try blocks, under one key", async () => {
    const js = await read(join(pub, "github.js"));
    expect(js.match(/localStorage\.\w+\(/g)).toEqual(["localStorage.getItem(", "localStorage.setItem("]);
    expect(js.match(/try \{\s*(var saved = JSON\.parse\()?localStorage\./g)?.length).toBe(2);
    expect(js).toContain('var KEY = "relay-github-stars";');
  });
});

describe("theme.js", () => {
  const forbidden = [
    "sessionStorage",
    "indexedDB",
    "document.cookie",
    "fetch(",
    "XMLHttpRequest",
    "sendBeacon",
    "WebSocket",
    "EventSource",
    "eval(",
    "new Function",
    "style",
    "http",
  ];

  test.each(forbidden)("does not contain %s", async (text) => {
    const js = (await read(join(pub, "theme.js"))).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(js).not.toContain(text);
  });

  test("reads and writes localStorage only inside try blocks, under one key", async () => {
    const js = await read(join(pub, "theme.js"));
    const uses = js.match(/localStorage\.\w+\(/g) ?? [];
    expect(uses).toEqual(["localStorage.getItem(", "localStorage.setItem("]);
    expect(js.match(/try \{\s*(var value = )?localStorage\./g)?.length).toBe(2);
    expect(js).toContain('var KEY = "relay-theme";');
  });

  test.each(htmlFiles)("%s loads it from the site, in <head>, before the stylesheet and without defer", async (name) => {
    const html = await read(join(pub, name));
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain('<script src="/theme.js"></script>');
    expect(head.indexOf('<script src="/theme.js">')).toBeLessThan(head.indexOf('<link rel="stylesheet"'));
    expect(head).toContain('<meta name="color-scheme" content="light">');
  });
});

describe("fonts", () => {
  test("site/fonts.sha256 lists exactly the six font files", async () => {
    expect(await read(join(site, "fonts.sha256"))).toBe(
      [
        "f3931c3c3ec5301043634ac8f39bcfa7b30d29181864f2fd0c3e6796feacc471  PublicSans-Regular.woff2",
        "26cedea8665bacddb7c2d9e22327cdfcfc00c517d1b9aef4c3e4dc54d792a1e4  PublicSans-Medium.woff2",
        "f99ffc265cc790e0f058a9f430a465c88996008327abb0f8561cb713add40d73  PublicSans-SemiBold.woff2",
        "ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350  IBMPlexMono-Regular.woff2",
        "33faf307fa6031fb4062276d7320a6d632de890cbb347576fd80cfa01077bc25  IBMPlexMono-Medium.woff2",
        "e739aff9b4d02c264341d6d4872edcda28e79373aeda936f659566a1cd3eb47f  Satoshi-Variable.woff2",
        "",
      ].join("\n"),
    );
  });

  test(".gitignore keeps the downloaded fonts out of git", async () => {
    const root = join(site, "..");
    expect(existsSync(join(root, ".gitignore"))).toBe(true);
    expect((await read(join(root, ".gitignore"))).split("\n")).toContain("site/public/fonts/");
  });
});
