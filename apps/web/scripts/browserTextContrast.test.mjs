import assert from "node:assert/strict";
import { test } from "node:test";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { collectTextContrast } from "./browserTextContrast.mjs";

test("real browser parses CSS4 and transparent colors without weakening contrast", async () => {
  const browser = await playwright.chromium.launch({
    executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>
      body { background: white; }
      span { display: block; color: black; }
      #rgb { background: rgb(214, 170, 77); }
      #srgb { background: color(srgb 0.839215686 0.666666667 0.301960784); }
      #oklab { background: color-mix(in oklab, #d6aa4d 100%, white); }
      #negative { background: oklab(0.8 -0.1 -0.1); }
      #opaque { background: black; }
      #transparent { background: rgb(255 255 255 / 50%); }
      #transparent-text { background: white; color: rgb(0 0 0 / 50%); }
      #bad { background: black; }
    </style><span id="rgb">rgb</span><span id="srgb">srgb</span><span id="oklab">oklab</span>
      <span id="negative">negative</span><div id="opaque"><span id="transparent">transparent</span></div>
      <span id="transparent-text">transparent-text</span><span id="bad">bad</span>`);
    const entries = await page.locator("body").evaluate(collectTextContrast, "span");
    const contrast = Object.fromEntries(entries.map(entry => [entry.text, entry.contrast]));
    assert.ok(contrast.rgb > 9 && contrast.rgb < 11);
    assert.ok(Math.abs(contrast.rgb - contrast.srgb) < .01);
    assert.ok(Math.abs(contrast.rgb - contrast.oklab) < .01);
    assert.ok(contrast.negative > 9);
    assert.ok(contrast.transparent > 5 && contrast.transparent < 6);
    assert.ok(contrast["transparent-text"] > 3 && contrast["transparent-text"] < 4.5);
    assert.equal(contrast.bad, 1);
    const serialized = await page.locator("#oklab").evaluate(node => getComputedStyle(node).backgroundColor);
    assert.match(serialized, /^oklab\(/);
    console.log(JSON.stringify({ serialized, contrast }));
  } finally { await browser.close(); }
});
