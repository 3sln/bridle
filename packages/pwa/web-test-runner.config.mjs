// @web/test-runner config — runs the browser tests in real Chromium. Uses the
// container's pre-installed Playwright Chromium via an executablePath override
// (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set, so nothing is downloaded).
//
// Browser tests live in test/browser/*.browser.js — note the `.browser.js`
// suffix, NOT `.test.js`, so `bun test` (which owns the unit/logic + node E2E
// suites) never tries to run them; they only run under `wtr`.
import { playwrightLauncher } from '@web/test-runner-playwright';
import { readdirSync, existsSync } from 'node:fs';

function chromiumExecutable() {
  const base = '/opt/pw-browsers';
  try {
    for (const dir of readdirSync(base)) {
      if (dir.startsWith('chromium-')) {
        const exe = `${base}/${dir}/chrome-linux/chrome`;
        if (existsSync(exe)) return exe;
      }
    }
  } catch {
    /* fall through to Playwright's own resolution */
  }
  return undefined;
}

export default {
  files: 'test/browser/**/*.browser.js',
  nodeResolve: true,
  concurrency: 1,
  // WebRTC negotiation needs a few seconds; give tests headroom.
  testFramework: { config: { timeout: '20000', ui: 'bdd' } },
  browsers: [
    playwrightLauncher({
      product: 'chromium',
      launchOptions: {
        executablePath: chromiumExecutable(),
        args: [
          '--no-sandbox',
          // Let getUserMedia resolve without a real device / prompt, in case a
          // test ever exercises the mic path.
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
        ],
      },
    }),
  ],
};
