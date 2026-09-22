import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = path.join(repoRoot, "test-output", "g7-volumetric-fog-gpu-20260920-r1");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

async function main() {
  const temporary = await mkdtemp(path.join(tmpdir(), "g7-fog-gpu-"));
  try {
    await build({ absWorkingDir: packageRoot, entryPoints: ["lab/volumetricFogGpuProbe.ts"], bundle: true,
      format: "esm", target: "es2022", outfile: path.join(temporary, "probe.mjs"), logLevel: "silent" });
    await writeFile(path.join(temporary, "probe.html"), "<!doctype html><title>G7 volumetric fog GPU probe</title>");
    const server = createServer(async (request, response) => {
      const name = new URL(request.url ?? "/", "http://127.0.0.1").pathname.slice(1);
      if (!["probe.html", "probe.mjs"].includes(name)) { response.writeHead(404).end(); return; }
      response.setHeader("Cache-Control", "no-store"); response.setHeader("Content-Type", name.endsWith("html") ? "text/html" : "text/javascript");
      response.end(await readFile(path.join(temporary, name)));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const require = createRequire(import.meta.url);
    const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
    const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true, args: ["--enable-unsafe-webgpu"] });
    let result;
    try {
      const page = await browser.newPage(); await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
      result = await page.evaluate(async () => (await import("./probe.mjs")).runVolumetricFogGpuProbe());
      result.environment = { chromeVersion: browser.version(), userAgent: await page.evaluate(() => navigator.userAgent) };
    } finally { await browser.close(); server.close(); }
    const passed = result.errors.length === 0 && result.cases.length === 3
      && result.cases.every(item => item.repeatStable && item.comparison.failingValues === 0);
    const evidence = { schema: "g7-volumetric-fog-gpu-evidence-v1", lane: "G7", createdAt: new Date().toISOString(),
      implementation: "production VolumetricFogPass + rgba16float readback", tolerance: { absolute: 8e-4, relative: 0.012 },
      ...result, verdict: { gpuVsCpu: passed, repeatStable: result.cases.every(item => item.repeatStable),
        productionRenderGraph: "not-connected" } };
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, "evidence.json"), JSON.stringify(evidence, null, 2));
    for (const item of result.cases) console.log(`${item.name}: repeat=${item.repeatStable} maxAbs=${item.comparison.maxAbsoluteError} failures=${item.comparison.failingValues}`);
    if (!passed) { console.error(`G7 GPU parity FAILED; evidence: ${outputDirectory}`); process.exitCode = 1; }
    else console.log(`G7 GPU parity PASSED; evidence: ${outputDirectory}`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

await main();
