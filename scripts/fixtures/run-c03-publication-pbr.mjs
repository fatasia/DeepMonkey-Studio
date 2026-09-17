import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const root=resolve(import.meta.dirname,'../..'), out=resolve(root,'test-output/de26-c03-publication-pbr');
const require=createRequire(resolve(root,'packages/deep-engine/package.json'));
const {build}=require('esbuild');
const cloudRequire=createRequire(resolve(root,'apps/cloud-render-worker/package.json'));
const playwright=cloudRequire('playwright-core');
await mkdir(out,{recursive:true});
const bundle=await build({absWorkingDir:root,entryPoints:['packages/deep-engine/lab/c03PublicationPbrPixels.ts'],bundle:true,format:'esm',target:'es2022',write:false,conditions:['development']});
const js=bundle.outputFiles[0].contents, tokens=await readFile(resolve(root,'apps/web/src/styles/base.css'));
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/tokens.css"><style>
body{margin:0;padding:24px;box-sizing:border-box;background:var(--bg-0);color:var(--text);font:13px system-ui}h1{margin:0 0 16px;color:var(--text-strong);font-size:20px}main{display:flex;flex-wrap:wrap;gap:16px}figure{margin:0;padding:12px;background:var(--surface-1);border:1px solid var(--line-subtle);border-radius:8px}canvas{display:block}figcaption{margin-top:8px;color:var(--text-muted)}pre{white-space:pre-wrap;font-size:11px}</style><h1>C03 作者发布 → PBR 像素诊断</h1><main></main><pre>正在编译并读取生产 PBR 帧…</pre><script type="module" src="/probe.js"></script></html>`;
const server=createServer((req,res)=>{if(req.url==='/favicon.ico'){res.writeHead(204).end();return;}const [body,type]=req.url==='/probe.js'?[js,'text/javascript']:req.url==='/tokens.css'?[tokens,'text/css']:[html,'text/html'];res.writeHead(200,{'Content-Type':type}).end(body);});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const url=`http://127.0.0.1:${server.address().port}`, browser=await playwright.chromium.launch({executablePath:process.env.BIM_STUDIO_CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const rounds=[], browserVersion=browser.version();
try {
  for(const [round,width,theme] of [[1,1280,'dark'],[2,980,'light']]){
    const page=await browser.newPage({viewport:{width,height:1050},deviceScaleFactor:1}),errors=[];
    page.on('pageerror',error=>errors.push(String(error))); page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await page.goto(url); await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
    await page.waitForFunction(()=>window.__c03Publication!==undefined,null,{timeout:60000});
    const result=await page.evaluate(()=>window.__c03Publication),overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
    if(overflow)errors.push('horizontal-overflow');
    const screenshot=await page.screenshot({path:resolve(out,`round-${round}.png`),fullPage:true});
    rounds.push({round,width,theme,result,errors,screenshotSha256:createHash('sha256').update(screenshot).digest('hex')});
    await page.close();
  }
} finally {await browser.close();server.close();}
const sourceHashes={};
for(const file of ['packages/deep-engine/lab/c03PublicationPbrPixels.ts','packages/deep-engine/src/threeBridge/ThreeProjectionBridge.ts','packages/deep-engine/src/runtimePackage/builder.ts','packages/deep-engine/src/webgpu/pbrRenderer.ts','packages/deep-engine/src/webgpu/pbrShader.ts'])sourceHashes[file]=createHash('sha256').update(await readFile(resolve(root,file))).digest('hex');
const evidence={schemaVersion:1,browserVersion,sourceHashes,bundleSha256:createHash('sha256').update(js).digest('hex'),rounds};
await writeFile(resolve(out,'evidence.json'),JSON.stringify(evidence,null,2)); console.log(JSON.stringify(evidence,null,2));
if(rounds.some(round=>!round.result?.success||round.errors.length))process.exitCode=1;
