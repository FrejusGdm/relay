// bun scripts/build.ts (add-lifetime-license, design decision 11): bundles the functions for
// Node.js into dist/, the folder Static Web Apps deploys with the API build skipped.
import { copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(root, "src", "index.ts")],
  target: "node",
  format: "cjs",
  outdir: dist,
  // The Azure Functions Node.js worker provides this module at run time.
  external: ["@azure/functions-core"],
  sourcemap: "linked",
});
if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}

copyFileSync(join(root, "host.json"), join(dist, "host.json"));
await Bun.write(
  join(dist, "package.json"),
  `${JSON.stringify({ name: "relay-license-server", version: "0.1.0", private: true, main: "index.js" })}\n`,
);
console.log("Built dist/index.js.");
