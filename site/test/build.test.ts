// site/scripts/build.sh: the switch that puts the buy form on the page only when buying is on
// (add-lifetime-license). Production is built with it off until live mode exists.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const site = join(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "relay-site-build-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function build(buy: string) {
  const out = join(work, buy);
  const result = Bun.spawnSync(["sh", join(site, "scripts", "build.sh"), out, buy]);
  return { code: result.exitCode, stderr: result.stderr.toString(), out };
}

const BUY_FORM = '<form class="buy-form" method="post" action="/api/checkout"><button type="submit" class="btn btn-primary">Buy a lifetime license</button></form>';
const files = (folder: string) => readdirSync(folder, { recursive: true, encoding: "utf8" }).filter((name) => !name.startsWith("fonts")).sort();

describe("buying off", () => {
  test("the copy is site/public as it is, without the buy form", () => {
    const { code, out } = build("off");
    expect(code).toBe(0);
    expect(files(out)).toEqual(files(join(site, "public")));
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toBe(readFileSync(join(site, "public", "index.html"), "utf8"));
    expect(html).not.toContain('action="/api/checkout"');
    expect(html).not.toContain('id="buy"');
    expect(html).toContain("Not on sale yet.");
  });
});

describe("buying on", () => {
  test("the paid column is replaced by the buy section, and nothing else changes", () => {
    const { code, out } = build("on");
    expect(code).toBe(0);
    const html = readFileSync(join(out, "index.html"), "utf8");
    const source = readFileSync(join(site, "public", "index.html"), "utf8");
    const pricing = html.match(/<section id="pricing">[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(pricing).toContain('<div class="price-col" id="buy">');
    expect(pricing).toContain(BUY_FORM);
    expect(html).not.toContain("Not on sale yet.");
    expect(html).not.toMatch(/buy:start|buy:end/);
    expect(html).not.toMatch(/\$\d|donat|buy now/i);
    const outside = (text: string) => text.replace(/<section id="pricing">[\s\S]*?<\/section>/, "");
    expect(outside(html)).toBe(outside(source));
    expect(html.match(/<form\b[^>]*>/gi)!.filter((form) => !form.includes('method="dialog"'))).toEqual([
      '<form class="buy-form" method="post" action="/api/checkout">',
    ]);
  });

  test("site/buy-section.html has the buy section of the design", () => {
    const fragment = readFileSync(join(site, "buy-section.html"), "utf8");
    expect(fragment).toContain(BUY_FORM);
    expect(fragment).not.toMatch(/\sstyle\s*=|<script|\son[a-z]+\s*=/i);
  });
});

test("any other value is refused", () => {
  const { code, stderr } = build("maybe");
  expect(code).toBe(2);
  expect(stderr).toContain("must be on or off");
});
