import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const index = () => Bun.file(join(root, "site", "public", "index.html")).text();
const workflow = join(root, ".github", "workflows", "release.yml");

const cliBlock = (asset: string) =>
  [
    'mkdir -p "$HOME/.local/bin"',
    "gh release download \\",
    "  --repo FrejusGdm/relay \\",
    `  --pattern ${asset} \\`,
    '  --output "$HOME/.local/bin/relay" \\',
    "  --clobber",
    'chmod +x "$HOME/.local/bin/relay"',
    '"$HOME/.local/bin/relay" --version',
  ].join("\n");

const blocks: Record<string, string> = {
  "install-macos-cmd": cliBlock("relay-darwin-arm64"),
  "install-linux-cmd": cliBlock("relay-linux-x64"),
};

// The text of the <pre> element with this id, with the two entities the page may use decoded.
const preText = (html: string, id: string) => {
  const match = html.match(new RegExp(`<pre id="${id}"[^>]*>([\\s\\S]*?)</pre>`));
  return match?.[1]?.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
};

describe.each(Object.keys(blocks))("#%s", (id) => {
  test("holds exactly the designed commands", async () => {
    expect(preText(await index(), id)).toBe(blocks[id]!);
  });

  test("has no line longer than 42 characters", async () => {
    for (const line of (preText(await index(), id) ?? "").split("\n")) expect(line.length).toBeLessThanOrEqual(42);
  });
});

test("every install button opens the one panel", async () => {
  const html = await index();
  expect(html).toMatch(/<div id="install" class="install" popover\b/);
  const targets = [...html.matchAll(/popovertarget="([^"]*)"/g)].map((m) => m[1]);
  expect(targets.length).toBeGreaterThanOrEqual(7);
  for (const target of targets) expect(target).toBe("install");
});

test("says the repository is private and how to check gh", async () => {
  const html = await index();
  expect(html).toContain("private");
  expect(html).toContain("gh auth status");
  expect(html).not.toMatch(/spctl|xattr/);
});

test("the Mac app block has no command and says the app is not released yet", async () => {
  const html = await index();
  // From the Mac app heading to the screen-reader status at the end of the panel.
  const block = html.match(/<h3 id="install-mac"[^>]*>Mac app<\/h3>[\s\S]*?(?=<p class="sr-only")/)?.[0] ?? "";
  expect(block).toContain(
    "The Mac menu-bar app is not released yet. The command line tool above works on its own.",
  );
  expect(block).not.toMatch(/<pre|data-copy/);
  expect(html).not.toContain("Relay-macOS.zip");
});

test("the Get relay buttons show the macOS command-line commands", async () => {
  const html = await index();
  const focus = [...html.matchAll(/data-install-focus="([^"]*)"/g)].map((m) => m[1]);
  expect(focus).toEqual(["install-macos", "install-macos"]);
  expect(html).not.toContain("Get relay for Mac");
});

test.skipIf(!existsSync(workflow))(
  "the release workflow builds the assets the panel downloads (skipped until .github/workflows/release.yml exists)",
  async () => {
    const yml = await Bun.file(workflow).text();
    for (const asset of ["relay-darwin-arm64", "relay-linux-x64"]) expect(yml).toContain(asset);
  },
);
