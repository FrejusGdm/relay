import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "bun";
import { join } from "node:path";
import { SettingsError } from "../../src/cli/errors";
import { ensureRelayHome, readPrivateFile } from "../../src/core/relay-home";
import { makeRelayHome } from "../helpers/home";

const uid = process.getuid!();

function settingsErrorLines(run: () => void): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof SettingsError) return error.lines;
    throw error;
  }
  throw new Error("expected a SettingsError");
}

describe("ensureRelayHome", () => {
  // Under umask 0o200 mkdir gives 0500, so this case shows that the chmod after mkdir is needed.
  test.each([0o077, 0o002, 0o200])("creates a missing folder with mode 0700 under umask %o", (mask) => {
    const folder = join(makeRelayHome(), "relay");
    const previous = process.umask(mask);
    try {
      ensureRelayHome(folder, uid);
    } finally {
      process.umask(previous);
    }
    expect(statSync(folder).mode & 0o777).toBe(0o700);
  });

  test("creates missing parent folders", () => {
    const folder = join(makeRelayHome(), "a", "b", "relay");
    ensureRelayHome(folder, uid);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
  });

  test("accepts an existing private folder and leaves its mode alone", () => {
    const folder = makeRelayHome();
    chmodSync(folder, 0o755);
    ensureRelayHome(folder, uid);
    expect(statSync(folder).mode & 0o777).toBe(0o755);
  });

  test("rejects a folder other users can change", () => {
    const folder = makeRelayHome();
    chmodSync(folder, 0o777);
    expect(settingsErrorLines(() => ensureRelayHome(folder, uid))).toEqual([
      `relay: other users can change ${folder}. Run "chmod 700 ${folder}" and try again.`,
    ]);
  });

  test("rejects a regular file in place of the folder", () => {
    const file = join(makeRelayHome(), "relay");
    writeFileSync(file, "");
    expect(settingsErrorLines(() => ensureRelayHome(file, uid))).toEqual([`relay: ${file} is not a folder.`]);
  });

  test("rejects a folder that belongs to another user", () => {
    const folder = makeRelayHome();
    expect(settingsErrorLines(() => ensureRelayHome(folder, uid + 1))).toEqual([
      `relay: ${folder} belongs to another user. relay only uses a folder you own.`,
    ]);
  });

  test("follows a symbolic link to a private folder, and rejects a broken one", () => {
    const base = makeRelayHome();
    mkdirSync(join(base, "target"), { mode: 0o700 });
    symlinkSync(join(base, "target"), join(base, "link"));
    ensureRelayHome(join(base, "link"), uid);

    symlinkSync(join(base, "missing"), join(base, "broken"));
    expect(settingsErrorLines(() => ensureRelayHome(join(base, "broken"), uid))).toEqual([
      `relay: cannot use ${join(base, "broken")}: it, or the file it links to, does not exist.`,
    ]);
  });

  // A test cannot create a link that another user owns, so this shows that the link itself is
  // checked before relay follows it.
  test("a symbolic link that is not the current user's is refused", () => {
    const base = makeRelayHome();
    symlinkSync(base, join(base, "link"));
    expect(settingsErrorLines(() => ensureRelayHome(join(base, "link"), uid + 1))).toEqual([
      `relay: ${join(base, "link")} belongs to another user. relay only uses a folder you own.`,
    ]);
  });

  test.each([0o600, 0o300, 0o500])("rejects a folder with mode %o that the owner cannot fully use", (mode) => {
    const folder = makeRelayHome();
    chmodSync(folder, mode);
    try {
      expect(settingsErrorLines(() => ensureRelayHome(folder, uid))).toEqual([
        `relay: you cannot read, write and open ${folder}. Run "chmod 700 ${folder}" and try again.`,
      ]);
    } finally {
      chmodSync(folder, 0o700);
    }
  });

  test("a path through a regular file is refused in plain words", () => {
    const file = join(makeRelayHome(), "file");
    writeFileSync(file, "");
    expect(settingsErrorLines(() => ensureRelayHome(join(file, "relay"), uid))).toEqual([
      `relay: cannot use ${join(file, "relay")}: part of the path is not a folder.`,
    ]);
  });

  test("control characters in the path are escaped", () => {
    const folder = join(makeRelayHome(), "a\u001b[31m\u009bb");
    mkdirSync(folder, { mode: 0o777 });
    chmodSync(folder, 0o777);
    const [line] = settingsErrorLines(() => ensureRelayHome(folder, uid));
    expect(line).not.toMatch(/[\u001b\u009b]/);
    expect(line).toContain("a\\u001b[31m\\u009bb");
  });
});

describe("readPrivateFile", () => {
  const fileWith = (mode: number, text = "") => {
    const file = join(makeRelayHome(), "config.toml");
    writeFileSync(file, text);
    chmodSync(file, mode);
    return file;
  };

  test("reads a file only its owner can change", () => {
    expect(readPrivateFile(fileWith(0o600, "a = 1\n"), uid, 10)).toBe("a = 1\n");
    expect(readPrivateFile(fileWith(0o644, "b"), uid, 10)).toBe("b");
  });

  test("returns null when nothing exists at the path", () => {
    expect(readPrivateFile(join(makeRelayHome(), "config.toml"), uid, 10)).toBeNull();
  });

  test("rejects a file other users can change", () => {
    const file = fileWith(0o620);
    expect(settingsErrorLines(() => readPrivateFile(file, uid, 10))).toEqual([
      `relay: other users can change ${file}. Run "chmod 600 ${file}" and try again.`,
    ]);
  });

  test("rejects a file that belongs to another user", () => {
    const file = fileWith(0o600);
    expect(settingsErrorLines(() => readPrivateFile(file, uid + 1, 10))).toEqual([
      `relay: ${file} belongs to another user. relay only uses a file you own.`,
    ]);
  });

  test("rejects a folder and a file that is too large", () => {
    const folder = makeRelayHome();
    expect(settingsErrorLines(() => readPrivateFile(folder, uid, 10))).toEqual([
      `relay: ${folder} is not a regular file.`,
    ]);
    const file = fileWith(0o600, "x".repeat(11));
    expect(settingsErrorLines(() => readPrivateFile(file, uid, 10))).toEqual([
      `relay: ${file} is larger than 10 bytes, the most relay reads.`,
    ]);
  });

  test("rejects a named pipe without waiting for a writer", () => {
    const pipe = join(makeRelayHome(), "config.toml");
    expect(spawnSync(["mkfifo", pipe]).exitCode).toBe(0);
    expect(settingsErrorLines(() => readPrivateFile(pipe, uid, 10))).toEqual([`relay: ${pipe} is not a regular file.`]);
  });

  test("a file the owner cannot read is refused in plain words", () => {
    const file = fileWith(0o200, "a = 1\n");
    expect(settingsErrorLines(() => readPrivateFile(file, uid, 10))).toEqual([
      `relay: cannot use ${file}: you do not have permission.`,
    ]);
  });
});
