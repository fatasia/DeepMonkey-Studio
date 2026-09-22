import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import playwright from "../apps/cloud-render-worker/node_modules/playwright-core/index.js";

const output = path.resolve(process.argv[2] ?? "test-output/scene-branding-browser");
const expectedTarget = process.argv[3] === "--native" ? "deep-native" : "three-webview";
await mkdir(output);
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { createServer, transformWithEsbuild } = await import(pathToFileURL(require.resolve("vite")).href);
const fixture = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{ScenePublicationDialog}from'/src/components/ScenePublicationDialog.tsx';
import{useGlobalDialogEscape}from'/src/hooks/useGlobalDialogEscape.ts';
import'/src/styles/base.css';import'/src/styles.css';
function App(){useGlobalDialogEscape();const[target,setTarget]=useState('three-webview');const[mode,setMode]=useState('webgl');const[performance,setPerformance]=useState('standard');
return <ScenePublicationDialog locale="zh-CN" sceneName="冷热电联供园区" mode={mode} performance={performance} defaultToolbarVisible={true}
 cloudConfigured={true} clientTarget={target} onClientTargetChange={setTarget} onModeChange={setMode} onPerformanceChange={setPerformance}
 onCancel={()=>{window.cancelled=true}} onPublish={async(...args)=>{window.published=args}}/>};
document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')||'dark';createRoot(document.getElementById('root')).render(<App/>);`;
const server = await createServer({ root: path.join(root, "apps/web"), configFile: false,
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "scene-branding-fixture",
    resolveId(id) { if (id === "/__scene-branding.tsx") return id; },
    async load(id) { if (id === "/__scene-branding.tsx") return (await transformWithEsbuild(fixture, id, { loader: "tsx", jsx: "automatic" })).code; },
    configureServer(dev) { dev.middlewares.use(async (request, response, next) => {
      if (!request.url?.startsWith("/__scene-branding?")) return next();
      response.setHeader("Content-Type", "text/html");
      response.end(await dev.transformIndexHtml(request.url, '<html><head></head><body><div id="root"></div><script type="module" src="/__scene-branding.tsx"></script></body></html>'));
    }); },
  }] });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await playwright.chromium.launch({ headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
const cases = [], icon = await readFile(path.join(root, "apps/web/public/brand/app-icon-chroma.png"));
try {
  for (const round of [1, 2]) for (const width of [1920, 980, 480]) for (const theme of ["dark", "light"]) {
    const id = `r${round}-${width}-${theme}`, errors = [];
    const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(`${origin}/__scene-branding?theme=${theme}`);
      const dialog = page.getByRole("dialog", { name: "发布运行版本" }); await dialog.waitFor();
      if (expectedTarget === "deep-native") await dialog.getByRole("button", { name: "Deep Native", exact: true }).click();
      const name = dialog.getByRole("textbox", { name: "客户端名称" });
      await name.fill("热电园区客户端");
      await dialog.locator("input[type=file]").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: icon });
      await page.waitForFunction(() => document.querySelector(".dashboard-client-icon")?.getAttribute("src")?.startsWith("data:image/png"));
      await dialog.locator(".dashboard-client-branding").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `${id}.png`) });
      const geometry = await dialog.evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
        viewport: innerWidth, overflow: node.querySelector(".dashboard-client-branding").scrollWidth > node.querySelector(".dashboard-client-branding").clientWidth }));
      assert(geometry.left >= 0 && geometry.right <= geometry.viewport && !geometry.overflow);
      await dialog.getByRole("button", { name: "发布", exact: true }).click();
      await page.waitForFunction(() => window.published);
      const published = await page.evaluate(() => window.published);
      assert.equal(published[1], expectedTarget); assert.equal(published[2].applicationName, "热电园区客户端");
      assert(published[2].iconDataUrl.startsWith("data:image/png"));
      await dialog.getByRole("button", { name: "恢复默认" }).click(); assert.equal(await name.inputValue(), "");
      await dialog.getByRole("button", { name: "仅发布", exact: true }).click(); assert.equal(await name.count(), 0);
      await dialog.getByRole("button", { name: "Deep Native", exact: true }).click(); assert.equal(await name.count(), 1);
      await page.keyboard.press("Escape"); assert(await page.evaluate(() => window.cancelled));
      assert.deepEqual(errors, []); cases.push({ id, passed: true, geometry });
    } catch (error) { cases.push({ id, passed: false, error: String(error), errors }); }
    finally { await context.close(); }
    console.log(`${cases.at(-1).passed ? "PASS" : "FAIL"} ${id}`);
  }
} finally {
  await browser.close(); await server.close();
  await writeFile(path.join(output, "result.json"), JSON.stringify({ scope: "Actual ScenePublicationDialog with isolated publication callback; archive and backend tested separately", cases }, null, 2));
}
assert(cases.every(item => item.passed), "Scene branding browser checks failed");
