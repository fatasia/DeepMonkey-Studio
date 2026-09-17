import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root=resolve(import.meta.dirname,'../..'), out=resolve(root,'test-output/de26-c03-browser');
const require=createRequire(resolve(root,'packages/deep-engine/package.json'));
const {build}=require('esbuild');
const cloudRequire=createRequire(resolve(root,'apps/cloud-render-worker/package.json'));
const playwright=cloudRequire('playwright-core');
await mkdir(out,{recursive:true});
const bundle=await build({absWorkingDir:root,entryPoints:['packages/deep-engine/lab/c03TransparencyPixels.ts'],bundle:true,format:'esm',target:'es2022',write:false});
const js=bundle.outputFiles[0].contents;
await writeFile(resolve(out,'probe.js'),js);
const tokens=await readFile(resolve(root,'apps/web/src/styles/base.css'));
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/tokens.css"><style>
body{margin:0;padding:24px;box-sizing:border-box;width:auto;min-width:0;background:var(--bg-0);color:var(--text);font:13px system-ui}h1{color:var(--text-strong);font-size:20px}
main{display:flex;flex-wrap:wrap;gap:16px}figure{margin:0}figcaption{margin-top:8px}canvas{width:128px;height:128px}pre{white-space:pre-wrap;font-size:12px}
</style><h1>透明合成像素诊断</h1><main></main><pre>正在读取 GPU 像素…</pre><script type="module" src="/probe.js"></script></html>`;
const server=createServer((req,res)=>{if(req.url==='/favicon.ico'){res.writeHead(204).end();return;}const [body,type]=req.url==='/probe.js'?[js,'text/javascript']:req.url==='/tokens.css'?[tokens,'text/css']:[html,'text/html'];res.writeHead(200,{'Content-Type':type}).end(body);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`;
const browser=await playwright.chromium.launch({executablePath:process.env.BIM_STUDIO_CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const rounds=[], browserVersion=browser.version();
try { for(const [round,width,theme] of [[1,1280,'dark'],[2,980,'light']]) {
  const page=await browser.newPage({viewport:{width,height:1100},deviceScaleFactor:1});const errors=[];
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(url);await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  await page.waitForFunction(()=>window.__c03!==undefined,null,{timeout:30000});
  const result=await page.evaluate(()=>window.__c03);
  const frames=await page.evaluate(()=>window.__c03frames??{}), frameHashes={};
  for(const [name,data] of Object.entries(frames)){const bytes=Buffer.from(data);await writeFile(resolve(out,`round-${round}-${name}.rgba`),bytes);frameHashes[name]=createHash('sha256').update(bytes).digest('hex');}
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);if(overflow)errors.push('horizontal-overflow');
  const screenshot=await page.screenshot({path:resolve(out,`round-${round}.png`),fullPage:true});
  rounds.push({round,width,theme,result,errors,frameHashes,screenshotSha256:createHash('sha256').update(screenshot).digest('hex')});await page.close();
} } finally {await browser.close();server.close();}
const sourceHashes={};
for(const file of ['packages/deep-engine/lab/c03TransparencyPixels.ts','packages/deep-engine/src/webgpu/deviceSession.ts','packages/deep-engine/src/webgpu/weightedOit.ts','packages/deep-engine/src/webgpu/weightedOitWgsl.ts'])sourceHashes[file]=createHash('sha256').update(await readFile(resolve(root,file))).digest('hex');
const evidence={schemaVersion:1,browser:'Chrome headless; no software/unsafe flags',browserVersion,sourceHashes,bundleSha256:createHash('sha256').update(js).digest('hex'),rounds};
await writeFile(resolve(out,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
if(rounds.some(r=>!r.result.success||r.errors.length))process.exitCode=1;
