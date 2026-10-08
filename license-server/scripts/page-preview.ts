// bun scripts/page-preview.ts: serves the website folder on port 7102 and answers /api/license with
// a made-up answer for one state, so the license page can be seen and photographed without Stripe
// (add-lifetime-license, task 7.1). The state comes from the request's `state` value, or else from
// its `session_id` value, because the page sends only session_id: open
// http://localhost:7102/license/?session_id=issued (or pending, not_found, error, loading).
// The key it shows is signed with a key pair made at start; it unlocks nothing.
import { generateKeyPairSync } from "node:crypto";
import { join, normalize } from "node:path";
import { signLicenseKey } from "../src/core/sign";

const port = Number(process.env.PAGE_PREVIEW_PORT ?? 7102);
const site = join(import.meta.dir, "..", "..", "site", "public");
const key = signLicenseKey({
  kid: "test-1",
  privateKey: generateKeyPairSync("ed25519").privateKey,
  licenseId: "3f9a2c1d5e7b9a01",
  issued: "2026-10-07",
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/license") {
      const state = url.searchParams.get("state") ?? url.searchParams.get("session_id");
      switch (state) {
        case "issued":
          return json(200, { state: "issued", key, license: "3f9a2c1d5e7b9a01", issued: "2026-10-07" });
        case "pending":
          return json(202, { state: "pending" });
        case "error":
          return json(503, { state: "error" });
        case "loading":
          // Never answers in time, so the page stays in its loading state.
          await Bun.sleep(60_000);
          return json(503, { state: "error" });
        default:
          return json(404, { state: "not_found" });
      }
    }
    let path = normalize(decodeURIComponent(url.pathname));
    if (path.endsWith("/")) path += "index.html";
    if (path.includes("..")) return new Response("Not found", { status: 404 });
    const file = Bun.file(join(site, path));
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 });
  },
});
console.log(`License page preview: http://127.0.0.1:${server.port}/license/?session_id=issued`);
