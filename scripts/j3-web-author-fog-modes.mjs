import {createServer} from "node:http";
import {createRequire} from "node:module";
import {readFile,writeFile,mkdir,rm} from "node:fs/promises";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
import path from "node:path";
const root=fileURLToPath(new URL("../",import.meta.url)),require=createRequire(import.meta.url),output=path.join(root,"test-output/interrupted-0930/web-author-fog-modes");
if(process.argv.length!==2)throw Error("Web author Fog modes requires two fresh devices; no prior evidence mode");
await mkdir(output,{recursive:true});await rm(path.join(output,"evidence.json"),{force:true});
const fixtureText=await readFile(path.join(root,"packages/deep-engine/fixtures/j3-web-author-fog-modes-v1.json"),"utf8"),fixture=JSON.parse(fixtureText);
const manifest=JSON.parse(await readFile(path.join(root,"packages/deep-engine/fixtures/j3-hdr-flat-normal-v1.json"),"utf8")),source=JSON.parse(await readFile(path.join(root,manifest.sourceFixture),"utf8"));
const hash=v=>createHash("sha256").update(v).digest("hex"),fixtureHash=hash(fixtureText),{build}=require("../packages/deep-engine/node_modules/esbuild");
const cpu=await build({absWorkingDir:root,entryPoints:["packages/deep-engine/lab/j3WebAuthorFogModes.ts"],outfile:path.join(output,"cpu.mjs"),bundle:true,format:"esm",platform:"node",metafile:true});
const web=await build({absWorkingDir:root,entryPoints:["packages/deep-engine/lab/j3WebAuthorFogModes.ts"],outfile:path.join(output,"probe.mjs"),bundle:true,format:"esm",platform:"browser",metafile:true});
const {buildWebAuthorModesPlan,compareWebAuthorModes}=await import(pathToFileURL(path.join(output,"cpu.mjs"))),plan=buildWebAuthorModesPlan(source,manifest,fixture);
await writeFile(path.join(output,"cpu-plan.json"),JSON.stringify({fixtureHash,plan}));
const files=[...Object.keys(cpu.metafile.inputs),...Object.keys(web.metafile.inputs),"packages/deep-engine/fixtures/j3-web-author-fog-modes-v1.json",
  "packages/deep-engine/fixtures/j3-hdr-flat-normal-v1.json",manifest.sourceFixture,"scripts/j3-web-author-fog-modes.mjs","apps/web/src/styles/base.css","packages/deep-engine/package.json","pnpm-lock.yaml"];
async function identity(){return Object.fromEntries(await Promise.all([...new Set(files)].sort().map(async file=>[file,hash(await readFile(path.join(root,file)))])));}
const before=await identity(),css=await readFile(path.join(root,"apps/web/src/styles/base.css"),"utf8");
const server=createServer(async(req,res)=>{
  if(req.url==="/probe.mjs"){res.setHeader("Content-Type","text/javascript");res.end(await readFile(path.join(output,"probe.mjs")));}
  else{res.setHeader("Content-Type","text/html; charset=utf-8");res.end(`<html data-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head><body style="background:var(--bg-0);color:var(--text-strong);padding:32px"><h1>作者 linear / 八步 volume</h1><p>Web合法profile · 同一场景 · 两相机 · 原85点</p><canvas width="128" height="128" style="width:512px;height:512px;image-rendering:pixelated"></canvas></body></html>`);}
});await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));let browser;const hosts=[],results=[];
try{
  const {chromium}=require("../apps/cloud-render-worker/node_modules/playwright-core");
  browser=await chromium.launch({headless:true,executablePath:process.env.BIM_STUDIO_CHROME_PATH??"C:/Program Files/Google/Chrome/Application/chrome.exe",args:["--enable-unsafe-webgpu"]});
  for(let run=0;run<2;run++){
    const page=await browser.newPage({viewport:{width:1920,height:1080},reducedMotion:"reduce"}),errors=[];page.on("pageerror",e=>errors.push(String(e)));
    await page.exposeFunction("captureFogModeFrame",async(id,round)=>{if(id==="oblique-author-volume-eight-step"&&round===0)await page.screenshot({path:path.join(output,`frame-fresh-${run}.png`)});});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const host=await page.evaluate(async a=>(await import("/probe.mjs")).runWebAuthorFogModes(document.querySelector("canvas"),a.source,a.manifest,a.fixture,
      (id,round)=>window.captureFogModeFrame(id,round)),{source,manifest,fixture});
    if(errors.length)throw Error(errors.join("\n"));await writeFile(path.join(output,`web-${run}.json`),JSON.stringify({...host,fixtureHash,freshInstance:run}));
    hosts.push(host);results.push(compareWebAuthorModes(plan,host));
    await page.close();
  }
}finally{try{await browser?.close();}finally{await new Promise(resolve=>server.close(resolve));}}
for(let i=0;i<hosts[0].frames.length;i++)if(hosts[0].frames[i].rgbaHash!==hosts[1].frames[i].rgbaHash)throw Error("Author Fog modes two fresh Web devices differ");
const after=await identity();if(JSON.stringify(before)!==JSON.stringify(after))throw Error("Consumed author Fog sources changed during run");
const evidence={passed:true,stable:true,currentRun:true,fixtureHash,web:results,sourceIdentity:before,execution:"Web-only two fresh devices, each profile/camera two draws",
  scope:results[0].scope,pointsCompared:results.reduce((n,r)=>n+r.pointsCompared,0),maxCpuError:Math.max(...results.map(r=>r.maxCpuError)),excluded:results[0].excluded};
await writeFile(path.join(output,"evidence.json"),JSON.stringify(evidence,null,2));
console.log(JSON.stringify({passed:true,currentRun:true,pointsCompared:evidence.pointsCompared,maxCpuError:evidence.maxCpuError,scope:evidence.scope}));
