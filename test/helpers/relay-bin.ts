// A program named relay that runs relay from source, for RELAY_BIN in tests of hooks and the
// status line. Settings files then hold "'<folder>/relay' hook claude Stop" as they would for an
// installed relay.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN } from "./cli";

export function relayBin(): string {
  const path = join(mkdtempSync(join(tmpdir(), "relay-bin-")), "relay");
  writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${MAIN}' "$@"\n`, { mode: 0o755 });
  return path;
}
