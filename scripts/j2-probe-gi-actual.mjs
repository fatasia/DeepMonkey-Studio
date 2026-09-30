import {createServer} from "node:http";
import {createRequire} from "node:module";
import {readFile,writeFile,mkdir,rm} from "node:fs/promises";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import path from "node:path";
import {validateProbeActualIdentity,compareProbeSamplingIntervals} from "./lib/j2ProbeGiActualIdentity.mjs";
const root=fileURLToPath(new URL("../",import.meta.url)),require=createRequire(import.meta.url),out=path.join(root,"test-output/interrupted-0930/probe-gi-actual");
const args=process.argv.slice(2),webOnly=args.includes("--web-only"),compareOnly=args.includes("--compare");
if(args.some(a=>a!=="--web-only"&&a!=="--compare")||(webOnly&&compareOnly))throw Error("Use default fresh dual host, --web-only (prior Native), or --compare (prior both)");
await mkdir(out,{recursive:true});await rm(path.join(out,"evidence.json"),{force:true});
const hash=v=>createHash("sha256").update(v).digest("hex"),fixtureText=await readFile(path.join(root,"packages/deep-engine/fixtures/j2-probe-gi-actual-v1.json"),"utf8"),fixture=JSON.parse(fixtureText);
const manifest=JSON.parse(await readFile(path.join(root,"packages/deep-engine/fixtures/j3-hdr-flat-normal-v1.json"),"utf8")),source=JSON.parse(await readFile(path.join(root,manifest.sourceFixture),"utf8"));
const {build}=require("../packages/deep-engine/node_modules/esbuild");
const cpu=await build({absWorkingDir:root,entryPoints:["packages/deep-engine/lab/j2ProbeGiActual.ts"],outfile:path.join(out,"cpu.mjs"),bundle:true,platform:"node",format:"esm",metafile:true});
const web=await build({absWorkingDir:root,entryPoints:["packages/deep-engine/lab/j2ProbeGiActual.ts"],outfile:path.join(out,"probe.mjs"),bundle:true,platform:"browser",format:"esm",metafile:true});
const {buildProbeActualPlan,compareProbeActual,probeActualPacket,probeActualShaderHash,probeGiGain}=await import(pathToFileURL(path.join(out,"cpu.mjs"))),plan=buildProbeActualPlan(source,manifest,fixture);
await writeFile(path.join(out,"cpu-plan.json"),JSON.stringify(plan));
const files=[...Object.keys(cpu.metafile.inputs),...Object.keys(web.metafile.inputs),"scripts/j2-probe-gi-actual.mjs","scripts/lib/j2ProbeGiActualIdentity.mjs","scripts/lib/j3ShadowVisibilityIntervals.mjs","packages/deep-engine/fixtures/j2-probe-gi-actual-v1.json","packages/deep-engine/fixtures/j3-hdr-flat-normal-v1.json",manifest.sourceFixture,
  "packages/deep-engine-native/tests/support/j2_probe_gi_actual.rs","packages/deep-engine-native/tests/support/shader_material_renderer.rs","packages/deep-engine-native/tests/support/shader_material_observers.rs",
  "packages/deep-engine-native/src/native_mesh_wgsl.rs","packages/deep-engine-native/src/probe_gi_wgsl.rs","packages/deep-engine-native/src/frame_bindings.rs","packages/deep-engine-native/src/probe_gi_storage.rs","packages/deep-engine-native/src/probe_gi_grid.rs",
  "packages/deep-engine-native/assets/shaders/native_mesh_v1.wgsl","packages/deep-engine-native/assets/shaders/native_cascaded_shadow_v1.wgsl","packages/deep-engine/wgsl/probeClipmapSampling.wgsl","packages/deep-engine/wgsl/materialDielectric.wgsl","packages/deep-engine/wgsl/brdfDirectLighting.wgsl","packages/deep-engine/wgsl/brdfDirectMultiscattering.wgsl","packages/deep-engine/wgsl/iesSampling.wgsl","packages/deep-engine/wgsl/cascadedShadowMath.wgsl"];
async function identity(){return Object.fromEntries(await Promise.all([...new Set(files)].sort().map(async p=>[p,hash(await readFile(path.join(root,p)))])));}
const before=await identity();
if(!webOnly&&!compareOnly){
  await rm(path.join(out,"native.json"),{force:true});
  await new Promise((resolve,reject)=>{const child=spawn("cargo",["test","--test","gpu_shader_material_draw","j2_b5_actual_probe_gi","--","--ignored","--nocapture"],{cwd:path.join(root,"packages/deep-engine-native"),env:process.env,stdio:["ignore","pipe","pipe"]});let log="";for(const stream of [child.stdout,child.stderr])stream.on("data",v=>{log+=v;process.stdout.write(v);});child.on("error",reject);child.on("close",async code=>{await writeFile(path.join(out,"native-run.log"),log);code===0?resolve():reject(Error(`Native actual probe exit ${code}`));});});
}
let hosts=[];
if(compareOnly){for(let run=0;run<2;run++)hosts.push(JSON.parse(await readFile(path.join(out,`web-${run}.json`),"utf8")));}
else{
  const css=await readFile(path.join(root,"apps/web/src/styles/base.css"),"utf8");
  const server=createServer(async(req,res)=>{if(req.url==="/probe.mjs"){res.setHeader("Content-Type","text/javascript");res.end(await readFile(path.join(out,"probe.mjs")));}else{res.setHeader("Content-Type","text/html; charset=utf-8");res.end(`<html data-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head><body style="background:var(--bg-0);color:var(--text-strong);padding:32px"><h1>探针 GI · 真实生产消费</h1><p>合法uniform输入 · 非金属正贡献 · 原85点 · 双宿主独立HDR期望</p><canvas width="128" height="128" style="width:512px;height:512px;image-rendering:pixelated"></canvas></body></html>`);}});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));let browser;
  try{const {chromium}=require("../apps/cloud-render-worker/node_modules/playwright-core");browser=await chromium.launch({headless:true,executablePath:process.env.BIM_STUDIO_CHROME_PATH??"C:/Program Files/Google/Chrome/Application/chrome.exe",args:["--enable-unsafe-webgpu"]});
    for(let run=0;run<2;run++){const page=await browser.newPage({viewport:{width:1920,height:1080},reducedMotion:"reduce"}),errors=[];page.on("pageerror",e=>errors.push(String(e)));
      await page.exposeFunction("captureProbeActual",async(id,round)=>{if(id==="oblique-uniform-b"&&round===0)await page.screenshot({path:path.join(out,`frame-fresh-${run}.png`)});});
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const host=await page.evaluate(async a=>(await import("/probe.mjs")).runProbeActual(document.querySelector("canvas"),a.source,a.manifest,a.fixture,(id,round)=>window.captureProbeActual(id,round)),{source,manifest,fixture});
      if(errors.length)throw Error(errors.join("\n"));const receipt={...host,profileHash:hash(fixtureText),freshInstance:run};await writeFile(path.join(out,`web-${run}.json`),JSON.stringify(receipt));hosts.push(receipt);await page.close();
    }
  }finally{try{await browser?.close();}finally{await new Promise(resolve=>server.close(resolve));}}
}
const native=JSON.parse(await readFile(path.join(out,"native.json"),"utf8"));
for(const h of [native,...hosts])if(h.profileHash!==hash(fixtureText))throw Error("Probe actual frozen fixture identity mismatch");
if(native.runs?.length!==2)throw Error("Native requires two fresh devices, each12frames");
const nativeHosts=native.runs.map(run=>({...native,...run}));
const comparisons=[...nativeHosts.map(h=>compareProbeActual(plan,h,"native")),...hosts.map(h=>compareProbeActual(plan,h,"web"))];
const actualIdentities=[...nativeHosts.map(h=>validateProbeActualIdentity(h,"native",probeActualPacket(source,fixture),fixture,probeActualShaderHash)),...hosts.map(h=>validateProbeActualIdentity(h,"web",probeActualPacket(source,fixture),fixture,probeActualShaderHash))];
const samplingComparisons=nativeHosts.map((h,i)=>compareProbeSamplingIntervals(plan,h,hosts[i],probeGiGain("native",fixture),probeGiGain("web",fixture)));
for(let i=0;i<nativeHosts[0].frames.length;i++)if(nativeHosts[0].frames[i].rgbaHash!==nativeHosts[1].frames[i].rgbaHash)throw Error("Probe Native fresh device full HDR hash changed");
for(let i=0;i<hosts[0].frames.length;i++)if(hosts[0].frames[i].rgbaHash!==hosts[1].frames[i].rgbaHash)throw Error("Probe Web fresh device full HDR hash changed");
const after=await identity();if(JSON.stringify(before)!==JSON.stringify(after))throw Error("Actual consumed probe source changed");
const evidence={passed:true,currentRun:!webOnly&&!compareOnly,profileHash:hash(fixtureText),sourceIdentity:before,comparisons,actualIdentities,samplingComparisons,pointsCompared:comparisons.reduce((n,c)=>n+c.pointsCompared,0),
  execution:compareOnly?"prior diagnostic both hosts":webOnly?"two fresh Web devices; prior Native two-device receipt":"two fresh Native and two fresh Web devices, each two draws",excluded:["init producer","capture commit","nonuniform probe interpolation","same HDR parity","real driver loss"]};
await writeFile(path.join(out,"evidence.json"),JSON.stringify(evidence,null,2));console.log(JSON.stringify({passed:true,currentRun:evidence.currentRun,comparisons,pointsCompared:evidence.pointsCompared}));
