import { expect, test } from "bun:test";
import { join } from "node:path";

const path = join(import.meta.dir, "..", "public", "staticwebapp.config.json");

test("staticwebapp.config.json holds exactly the routes and headers of the design", async () => {
  expect(await Bun.file(path).json()).toEqual({
    routes: [
      { route: "/.auth/login/github", statusCode: 404 },
      { route: "/.auth/login/aad", statusCode: 404 },
      { route: "/.auth/*", statusCode: 404 },
      { route: "/fonts/*", headers: { "Cache-Control": "public, max-age=604800" } },
    ],
    responseOverrides: {
      "404": { rewrite: "/404.html", statusCode: 404 },
    },
    mimeTypes: {
      ".woff2": "font/woff2",
    },
    globalHeaders: {
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src https://api.github.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Robots-Tag": "noindex, nofollow",
      "Cache-Control": "no-cache",
    },
  });
});

test("staticwebapp.config.json is under the 20 KB limit", () => {
  expect(Bun.file(path).size).toBeLessThan(20 * 1024);
});
