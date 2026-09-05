import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { collectTextContrast } from "./browserTextContrast.mjs";

const gate = await createIsolatedStudioGate("application-error");
const report = { createdAt: new Date().toISOString(), cases: [] };
console.log(JSON.stringify({ output: gate.output }));
try {
  for (const [theme, width, locale = "zh-CN"] of [["dark", 1440], ["light", 980], ["dark", 480], ["light", 480], ["light", 980, "en-US"], ["dark", 480, "en-US"]]) {
    for (const kind of ["render", "startup", "public-render"]) {
      const entry = { theme, width, locale, kind, passed: false, expectedErrors: [], writes: [] }; report.cases.push(entry);
      const context = await gate.browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      const url = `${gate.origin}${kind === "public-render" ? "/apps/error-gate-missing" : "/manager"}?recovery=keep#keep`;
      const module = kind === "public-render" ? "PublishedApplicationRoot" : "App";
      let fault = true, failures = 0;
      await context.route("**/*", async route => {
        const request = route.request(); const path = new URL(request.url()).pathname;
        if (request.isNavigationRequest()) {
          const response = await route.fetch(); const html = await response.text();
          return route.fulfill({ response, body: html.replace(/<html\b[^>]*>/, `<html lang="${locale}" data-theme="${theme}">`) });
        }
        if (fault && new RegExp(`/assets/${module}-[^/]+\\.js$`).test(path)) {
          failures++;
          const problem = 'new Error("CONTROLLED_GATE_FAILURE private-payload-must-not-be-shown")';
          return route.fulfill({ status: 200, contentType: "text/javascript", body: kind === "startup"
            ? `throw ${problem}; export function ${module}() {}` : `export function ${module}() {throw ${problem};}` });
        }
        return route.continue();
      });
      page.on("console", message => { if (message.type() === "error") entry.expectedErrors.push(message.text()); });
      page.on("pageerror", error => entry.expectedErrors.push(error.message));
      page.on("request", request => { if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) entry.writes.push(request.url()); });
      try {
        await page.goto(url);
        const fallback = page.locator(".application-error"); await fallback.waitFor();
        assert.equal(failures, 1); assert.equal(await fallback.getAttribute("role"), "alert");
        const text = await fallback.innerText();
        assert.match(text, kind === "startup" ? /STUDIO_STARTUP_FAILED/ : /STUDIO_RENDER_FAILED/);
        assert.doesNotMatch(text, /private-payload|CONTROLLED_GATE_FAILURE/);
        await page.waitForTimeout(500); assert.equal(page.url(), url, "No automatic reload/navigation");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        entry.contrast = await fallback.evaluate(collectTextContrast, "h1, p, button, small, code");
        assert.deepEqual(entry.contrast.filter(item => item.text && item.contrast < 4.5), []);
        const button = fallback.getByRole("button", { name: locale === "en-US" ? "Reload page" : "刷新当前页面", exact: true });
        await page.keyboard.press("Tab"); assert.equal(await button.evaluate(element => element === document.activeElement), true);
        await page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${locale}-${kind}.png`) });
        assert.deepEqual(entry.expectedErrors.filter(message => !/CONTROLLED_GATE_FAILURE|STUDIO_(STARTUP|RENDER)_FAILED/.test(message)), []);
        fault = false;
        await Promise.all([page.waitForNavigation(), button.press("Enter")]);
        await fallback.waitFor({ state: "detached" }); assert.equal(page.url(), url);
        await page.locator(kind === "public-render" ? ".published-application" : 'input[type="password"]').waitFor();
        assert.deepEqual(entry.writes, []);
        entry.passed = true;
      } catch (error) {
        entry.failure = error.stack; await page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${kind}-failed.png`) }); throw error;
      } finally { await context.close(); console.log(JSON.stringify(entry)); }
    }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, passed: report.cases.every(item => item.passed) }));
