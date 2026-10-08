// Task 2.1: the runtime directory, its checks, and the socket path length limit.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import {
  checkSocketPathLength,
  DaemonStartError,
  prepareRuntimeDir,
  removeStaleSocket,
  runtimeDir,
  socketPath,
} from "../../src/daemon/paths";
import { removeTempRelayHomes, tempRelayHome } from "../helpers/relay-home";

afterAll(removeTempRelayHomes);

const refusal = (run: () => void): string => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DaemonStartError);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
};

describe("runtimeDir", () => {
  test("is $RELAY_HOME/run on macOS, and on Linux whenever RELAY_HOME is set", () => {
    expect(runtimeDir({ RELAY_HOME: "/r", XDG_RUNTIME_DIR: "/run/user/1000" }, "/r", "linux")).toBe("/r/run");
    expect(runtimeDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, "/h/.relay", "darwin")).toBe("/h/.relay/run");
  });

  test("is $XDG_RUNTIME_DIR/relay on Linux without RELAY_HOME, and falls back when it is unset or relative", () => {
    expect(runtimeDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, "/h/.relay", "linux")).toBe("/run/user/1000/relay");
    expect(runtimeDir({}, "/h/.relay", "linux")).toBe("/h/.relay/run");
    expect(runtimeDir({ XDG_RUNTIME_DIR: "run" }, "/h/.relay", "linux")).toBe("/h/.relay/run");
  });
});

describe("prepareRuntimeDir", () => {
  test("creates a missing directory with mode 0700", () => {
    const dir = join(tempRelayHome(), "run");
    prepareRuntimeDir(dir);
    const stats = lstatSync(dir);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o700);
  });

  test("accepts an existing private directory and leaves its mode alone", () => {
    const dir = join(tempRelayHome(), "run");
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o500);
    prepareRuntimeDir(dir);
    expect(lstatSync(dir).mode & 0o777).toBe(0o500);
    chmodSync(dir, 0o700);
  });

  test("refuses a directory that group or others can use, with the chmod hint, and does not change it", () => {
    const dir = join(tempRelayHome(), "run");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    expect(refusal(() => prepareRuntimeDir(dir))).toBe(
      `relay cannot start: ${dir} must be private (mode 0700, owned by you). Fix it with: chmod 700 ${dir}`,
    );
    expect(lstatSync(dir).mode & 0o777).toBe(0o755);
  });

  test("refuses a symbolic link, also one that leads to a private directory or nowhere", () => {
    const home = tempRelayHome();
    const target = join(home, "elsewhere");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(home, "run"));
    symlinkSync(join(home, "missing"), join(home, "dangling"));
    for (const name of ["run", "dangling"]) {
      const dir = join(home, name);
      expect(refusal(() => prepareRuntimeDir(dir))).toBe(`relay cannot start: ${dir} is a symbolic link.`);
    }
  });

  test("refuses a directory owned by another user", () => {
    const dir = join(tempRelayHome(), "run");
    mkdirSync(dir, { mode: 0o700 });
    const real = lstatSync(dir);
    const otherOwner = () =>
      ({ isSymbolicLink: () => false, isDirectory: () => true, uid: real.uid + 1, mode: real.mode }) as unknown as Stats;
    expect(refusal(() => prepareRuntimeDir(dir, otherOwner))).toBe(
      `relay cannot start: ${dir} must be private (mode 0700, owned by you). Fix it with: chmod 700 ${dir}`,
    );
  });

  test("refuses a file in place of the directory", () => {
    const dir = join(tempRelayHome(), "run");
    writeFileSync(dir, "");
    expect(refusal(() => prepareRuntimeDir(dir))).toContain("must be private");
  });
});

describe("checkSocketPathLength", () => {
  // A path of exactly `bytes` bytes that ends in run/relay.sock.
  const pathOf = (bytes: number) => {
    const tail = "/run/relay.sock";
    return `/${"a".repeat(bytes - tail.length - 1)}${tail}`;
  };

  test.each([
    ["darwin", 103],
    ["linux", 107],
  ] as const)("on %s, a socket path of %d bytes is accepted and one byte more is refused", (platform, max) => {
    expect(() => checkSocketPathLength(pathOf(max), platform)).not.toThrow();
    const long = pathOf(max + 1);
    expect(Buffer.byteLength(long)).toBe(max + 1);
    expect(refusal(() => checkSocketPathLength(long, platform))).toBe(
      `relay cannot start: the socket path ${long} is too long. Set RELAY_HOME to a shorter path.`,
    );
  });

  test("counts bytes, not characters", () => {
    const path = `/${"é".repeat(50)}/run/relay.sock`;
    expect(path.length).toBeLessThan(103);
    expect(() => checkSocketPathLength(path, "darwin")).toThrow(DaemonStartError);
  });
});

describe("removeStaleSocket", () => {
  test("removes a socket, ignores a missing path and refuses anything else", () => {
    const dir = tempRelayHome();
    const path = socketPath(dir);
    removeStaleSocket(path);
    // Bun removes the socket file when a listener stops, so this one is removed while it listens.
    const listener = Bun.listen({ unix: path, socket: { data() {} } });
    expect(lstatSync(path).isSocket()).toBe(true);
    removeStaleSocket(path);
    expect(existsSync(path)).toBe(false);
    listener.stop(true);
    writeFileSync(path, "");
    expect(refusal(() => removeStaleSocket(path))).toBe(`relay cannot start: ${path} exists and is not a socket.`);
  });
});
