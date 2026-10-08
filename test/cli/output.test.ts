import { expect, test } from "bun:test";
import { MAIN } from "../helpers/cli";

// The reader on the right closes the pipe at once, before relay writes its help.
test("relay --help into a closed pipe exits 0 without an error", () => {
  const script = '{ "$0" --no-env-file "$1" --help; echo "exit=$?" >&2; } | { exec 0<&-; sleep 0.5; }';
  const result = Bun.spawnSync(["bash", "-c", script, process.execPath, MAIN], { env: process.env });
  expect(result.stderr.toString()).toBe("exit=0\n");
});
