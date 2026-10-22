import { defineConfig } from "@playwright/test";

// Real-browser layout checks (`npm run test:layout`). Not part of `npm test`:
// they need a Chromium (`npx playwright install chromium`) and a built dist/.
// The specs are *.e2e.ts so vitest's *.test.ts / *.spec.ts glob never sees them.
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  outputDir: "layout-shots/results",
  reporter: "list",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4391",
    serviceWorkers: "block",
  },
  webServer: {
    command: "npx vite preview --host 127.0.0.1 --port 4391 --strictPort",
    url: "http://127.0.0.1:4391/whisper-hid/",
    reuseExistingServer: false,
  },
});
