import { defineConfig } from "@playwright/test";
import { DOCS_PORT, REMOTE, SERVER_PASSWORD, SIGNAL_PORT } from "./e2e/browser/env.mjs";

// Browser tests: several real Chromium peers load docs/index.html and chat over
// WebRTC, signaling through the local Express server or E2E_BASE_URL.
//
// Every peer tab polls the signaling server about once per second, so against a
// deployment (billed per request/invocation) only the @remote smoke tests run, on
// one worker, stopping at the first failure. E2E_REMOTE_ALL=1 runs everything.
const REMOTE_SMOKE_ONLY = Boolean(REMOTE) && !process.env.E2E_REMOTE_ALL;

export default defineConfig({
  testDir: "e2e/browser",
  timeout: 120_000,
  expect: { timeout: REMOTE ? 20_000 : 30_000 },
  workers: REMOTE ? 1 : 2,
  maxFailures: REMOTE ? 1 : 0,
  grep: REMOTE_SMOKE_ONLY ? /@remote/ : undefined,
  reporter: [["list"]],
  use: {
    // Full headless Chromium. Chromium hides host IPs behind mDNS ".local" names
    // by default; those do not resolve in CI/sandboxed hosts, so peers would never
    // find a path. With the feature off, host candidates carry real IPs.
    channel: "chromium",
    launchOptions: { args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run build && node e2e/browser/static-server.mjs",
      port: DOCS_PORT,
      env: { PORT: String(DOCS_PORT) },
      reuseExistingServer: false,
      stdout: "ignore",
    },
    ...(REMOTE
      ? []
      : [
          {
            command: "npm --prefix server run build && node server/dist/index.js",
            url: `http://127.0.0.1:${SIGNAL_PORT}/v1/rooms`, // 401 counts as ready
            env: { PORT: String(SIGNAL_PORT), SERVER_PASSWORD },
            reuseExistingServer: false,
            stdout: "ignore",
          },
        ]),
  ],
});
