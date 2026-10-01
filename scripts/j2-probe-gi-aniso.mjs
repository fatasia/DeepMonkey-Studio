import {createServer} from "node:http";
import {createRequire} from "node:module";
import {readFile,writeFile,mkdir,rm} from "node:fs/promises";
import {existsSync} from "node:fs";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import path from "node:path";
import {validateProbeAnisoIdentity,validateProbeAnisoEvidence} from "./lib/j2ProbeAnisoIdentity.mjs";
const root=fileURLToPath(new URL("../",import.meta.url)),require=createRequire(import.meta.url),out=path.join(root,"test-output/interrupted-0930/probe-gi-aniso");
const args=process.argv.slice(2),prepareOnly=args.includes("--prepare"),compareOnly=args.includes("--compare");
if(args.some(a=>a!=="--prepare"&&a!=="--compare")||(prepareOnly&&compareOnly))throw Error("Use default fresh dual host, --prepare, or --compare (prior evidence diagnostic)");
await mkdir(out,{recursive:true});
const hash=v=>createHash("sha256").update(v).digest("hex"),fixtureText=await readFile(path.join(root,"packages/deep-engine/fixtures/j2-probe-gi-aniso-v1.json"),"utf8"),fixture=JSON.parse(fixtureText);
const manifest=JSON.parse(await readFile(path.join(root,"packages/deep-engine/fixtures/j3-hdr-flat-normal-v1.json"),"utf8")),source=JSON.parse(await readFile(path.join(root,manifest.sourceFixture),"utf8"));
const {build}=require("../packages/deep-engine/node_modules/esbuild");
const cpu=await build({absWorkingDir:root,entryPoints:["packages/deep-engine/lab/j2ProbeGiAnisoFixture.ts"],outfile:path.join(out,"cpu.mjs"),bundle:true,platform:"node",format:"esm",metafile:true});
const web=await build({absWorkingDir:root,entryPoints:["packages/deep-engine/lab/j2ProbeGiAnisoFixture.ts"],outfile:path.join(out,"probe.mjs"),bundle:true,platform:"browser",format:"esm",metafile:true});
const {buildProbeAnisoPlan,compareProbeAniso,anisoProbePacket,probeAnisoShaderHash}=await import(pathToFileURL(path.join(out,"cpu.mjs"))),plan=buildProbeAnisoPlan(source,manifest,fixture);
const frozen={origin:fixture.origin,spacing:fixture.spacing,normalBiasCells:fixture.normalBiasCells,absoluteTolerance:fixture.absoluteTolerance};
const coreFiles=["packages/deep-engine/fixtures/j2-probe-gi-aniso-v1.json","packages/deep-engine/fixtures/j3-hdr-flat-normal-v1.json",manifest.sourceFixture,
  "packages/deep-engine/lab/j2ProbeGiAnisoFixture.ts","scripts/j2-probe-gi-aniso.mjs","scripts/lib/j2ProbeAnisoIdentity.mjs",
  "packages/deep-engine-native/tests/support/shader_material_renderer.rs","packages/deep-engine-native/tests/support/shader_material_observers.rs",
  "packages/deep-engine-native/src/native_mesh_wgsl.rs","packages/deep-engine-native/src/probe_gi_wgsl.rs","packages/deep-engine-native/src/frame_bindings.rs","packages/deep-engine-native/src/probe_gi_storage.rs","packages/deep-engine-native/src/probe_gi_grid.rs",
  "packages/deep-engine-native/assets/shaders/native_mesh_v1.wgsl","packages/deep-engine-native/assets/shaders/native_cascaded_shadow_v1.wgsl","packages/deep-engine/wgsl/probeClipmapSampling.wgsl","packages/deep-engine/wgsl/materialDielectric.wgsl","packages/deep-engine/wgsl/brdfDirectLighting.wgsl","packages/deep-engine/wgsl/brdfDirectMultiscattering.wgsl","packages/deep-engine/wgsl/iesSampling.wgsl","packages/deep-engine/wgsl/cascadedShadowMath.wgsl"];
const nativeSupportFiles=["packages/deep-engine-native/tests/support/j2_probe_gi_aniso.rs"];
async function identity(){return Object.fromEntries(await Promise.all([...coreFiles,...nativeSupportFiles].sort().map(async p=>{
  if(!existsSync(path.join(root,p))){if(nativeSupportFiles.includes(p))return [p,"pending-native-support"];throw Error(`Aniso identity file missing: ${p}`);}
  return [p,hash(await readFile(path.join(root,p)))];})));}
const inputHash={profileHash:hash(fixtureText),sourceIdentity:await identity()};
if(prepareOnly){
  await writeFile(path.join(out,"cpu-plan.json"),JSON.stringify(plan));
  await writeFile(path.join(out,"pre-gpu-input.json"),JSON.stringify({schema:"j2-b5-aniso-input-v1",inputHash,frozen,admission:plan.admission,
    planHash:hash(JSON.stringify(plan)),pointsCompared:plan.cameras.reduce((n,c)=>n+c.points.length,0),scope:"CPU prepare only; GPU owned by root",currentRun:false},null,2));
  console.log(JSON.stringify({passed:true,prepare:true,admission:plan.admission,points:85,scenarios:["zero","z-ramp","checker"],inputHash}));
}else{
  const nativeSupport=nativeSupportFiles.every(p=>existsSync(path.join(root,p)));
  if(!nativeSupport&&!compareOnly)throw Error(`Native support missing (${nativeSupportFiles.join(", ")}): root must add the j2_b5_aniso_probe_gi test per spec before the GPU run`);
  if(!compareOnly){
    await writeFile(path.join(out,"cpu-plan.json"),JSON.stringify(plan));
    await rm(path.join(out,"native.json"),{force:true});
    await new Promise((resolve,reject)=>{const child=spawn("cargo",["test","--test","gpu_shader_material_draw","j2_b5_aniso_probe_gi","--","--ignored","--nocapture"],{cwd:path.join(root,"packages/deep-engine-native"),env:{...process.env,J2_ANISO_PLAN_PATH:path.join(out,"cpu-plan.json")},stdio:["ignore","pipe","pipe"]});let log="";for(const stream of [child.stdout,child.stderr])stream.on("data",v=>{log+=v;process.stdout.write(v);});child.on("error",reject);child.on("close",async code=>{await writeFile(path.join(out,"native-run.log"),log);code===0?resolve():reject(Error(`Native aniso probe exit ${code}`));});});
  }
  let hosts=[];
  if(compareOnly){
    const evidence=JSON.parse(await readFile(path.join(out,"evidence.json"),"utf8"));
    validateProbeAnisoEvidence(evidence,fixtureText,inputHash.sourceIdentity);
    for(let run=0;run<2;run++)hosts.push(JSON.parse(await readFile(path.join(out,`web-${run}.json`),"utf8")));
  }else{
    const css=await readFile(path.join(root,"apps/web/src/styles/base.css"),"utf8");
    const server=createServer(async(req,res)=>{if(req.url==="/probe.mjs"){res.setHeader("Content-Type","text/javascript");res.end(await readFile(path.join(out,"probe.mjs")));}else{res.setHeader("Content-Type","text/html; charset=utf-8");res.end(`<html data-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head><body style="background:var(--bg-0);color:var(--text-strong);padding:32px"><h1>探针 GI · 非均匀后继</h1><p>z层梯度+棋盘非均匀输入 · 双族独立oracle · 原85点 · storage vs biased texture</p><canvas width="128" height="128" style="width:512px;height:512px;image-rendering:pixelated"></canvas></body></html>`);}});
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));let browser;
    try{const {chromium}=require("../apps/cloud-render-worker/node_modules/playwright-core");browser=await chromium.launch({headless:true,executablePath:process.env.BIM_STUDIO_CHROME_PATH??"C:/Program Files/Google/Chrome/Application/chrome.exe",args:["--enable-unsafe-webgpu"]});
      for(let run=0;run<2;run++){const page=await browser.newPage({viewport:{width:1920,height:1080},reducedMotion:"reduce"}),errors=[];page.on("pageerror",e=>errors.push(String(e)));
        await page.exposeFunction("captureProbeAniso",async(id,round)=>{if(id==="oblique-z-ramp"&&round===0)await page.screenshot({path:path.join(out,`frame-fresh-${run}.png`)});});
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        const host=await page.evaluate(async a=>(await import("/probe.mjs")).runProbeAniso(document.querySelector("canvas"),a.source,a.manifest,a.fixture,(id,round)=>window.captureProbeAniso(id,round)),{source,manifest,fixture});
        if(errors.length)throw Error(errors.join("\n"));const receipt={...host,profileHash:hash(fixtureText),freshInstance:run};await writeFile(path.join(out,`web-${run}.json`),JSON.stringify(receipt));hosts.push(receipt);await page.close();
      }
    }finally{try{await browser?.close();}finally{await new Promise(resolve=>server.close(resolve));}}
  }
  const native=JSON.parse(await readFile(path.join(out,"native.json"),"utf8"));
  if(native.profileHash!==hash(fixtureText))throw Error("Probe aniso frozen fixture identity mismatch");
  if(!compareOnly)for(const h of hosts)if(h.profileHash!==hash(fixtureText))throw Error("Probe aniso frozen fixture identity mismatch");
  if(native.runs?.length!==2)throw Error("Native requires two fresh devices, each12frames");
  const nativeHosts=native.runs.map(run=>({...native,...run}));
  const comparisons=[...nativeHosts.map(h=>compareProbeAniso(plan,h,"native")),...hosts.map(h=>compareProbeAniso(plan,h,"web"))];
  const identities=[...nativeHosts.map(h=>validateProbeAnisoIdentity(h,"native",anisoProbePacket(source,fixture),fixture,probeAnisoShaderHash)),...hosts.map(h=>validateProbeAnisoIdentity(h,"web",anisoProbePacket(source,fixture),fixture,probeAnisoShaderHash))];
  if(!compareOnly){
    for(let i=0;i<nativeHosts[0].frames.length;i++)if(nativeHosts[0].frames[i].rgbaHash!==nativeHosts[1].frames[i].rgbaHash)throw Error("Probe aniso Native fresh device full HDR hash changed");
    for(let i=0;i<hosts[0].frames.length;i++)if(hosts[0].frames[i].rgbaHash!==hosts[1].frames[i].rgbaHash)throw Error("Probe aniso Web fresh device full HDR hash changed");
  }
  const after=await identity();
  // The end-of-run guard compares source identities only: inputHash wraps them
  // with profileHash, so comparing the whole envelopes was structurally always
  // false and the guard could never pass (earlier full runs died at the
  // comparison stage before reaching this line).
  if(JSON.stringify(inputHash.sourceIdentity)!==JSON.stringify(after)){
    const diffKeys=Object.keys({...inputHash.sourceIdentity,...after}).filter(k=>inputHash.sourceIdentity[k]!==after[k]);
    throw Error("Aniso consumed probe source changed: "+JSON.stringify(diffKeys.map(k=>({file:k,before:(inputHash.sourceIdentity[k]??"").slice(0,12),after:(after[k]??"").slice(0,12)}))));}
  const evidence={passed:true,currentRun:!compareOnly,inputHash:after,frozen,admission:plan.admission,comparisons,identities,
    pointsCompared:comparisons.reduce((n,c)=>n+c.pointsCompared,0),
    execution:compareOnly?"prior diagnostic both hosts":"two fresh Native and two fresh Web devices, each two draws",
    scope:"anisotropic follow-up: storage vs biased texture z cells under z-ramp/checker; independent host oracles; no bare-HDR parity",
    excluded:["init producer","capture commit","dynamic light leak","full B5","same HDR parity"]};
  await writeFile(path.join(out,"evidence.json"),JSON.stringify(evidence,null,2));console.log(JSON.stringify({passed:true,currentRun:evidence.currentRun,comparisons,pointsCompared:evidence.pointsCompared,admission:plan.admission}));
}
