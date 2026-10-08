// A second process for test/platform/file-lock.test.ts. It tries to take the lock at argv[2] and
// prints "locked" or "busy". With "locked" it keeps the lock until it is killed. With the extra
// argument "spawn" it first starts a `sleep` child and prints that child's pid.
import { tryLock } from "../../src/platform/file-lock";

const handle = tryLock(process.argv[2]!);
if (handle !== null && process.argv[3] === "spawn") {
  const child = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
  console.log(`child ${child.pid}`);
}
console.log(handle === null ? "busy" : "locked");
if (handle !== null) setInterval(() => {}, 60_000);
