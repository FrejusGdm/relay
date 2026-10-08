import { defineConfig } from "@playwright/test";

const port = Number(process.env.SITE_PORT ?? 4280);
const live = process.env.SITE_URL;
// The folder the local emulator serves: site/public, or a copy from site/scripts/build.sh.
const root = process.env.SITE_ROOT ?? "public";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pw.ts",
  outputDir: "./e2e/results",
  workers: 1,
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    baseURL: live ?? `http://127.0.0.1:${port}`,
  },
  webServer: live
    ? undefined
    : {
        command: `npx --yes @azure/static-web-apps-cli@2.0.10 start ${root} --host 127.0.0.1 --port ${port}`,
        url: `http://127.0.0.1:${port}/`,
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
