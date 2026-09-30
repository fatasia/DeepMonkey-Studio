import {createServer} from "node:http";
import {mkdir,readFile,writeFile,rm} from "node:fs/promises";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {compareCsmTimings} from "./lib/j2CsmTimingParity.mjs";
const root=fileURLToPath(new URL("../",import.meta.url));
const out=path.join(root,"test-output/interrupted-0930/csm-timing");
const flags=new Set(process.argv.slice(2));
if(flags.size>1||[...flags].some(f=>!["--compare","--web-only"].includes(f)))throw Error("Choose default, --web-only or --compare");
const compare=flags.has("--compare"),webOnly=flags.has("--web-only");
const require=createRequire(import.meta.url),{build}=require("../packages/deep-engine/node_modules/esbuild");
const hash=x=>createHash("sha256").update(x).digest("hex");
const read=p=>readFile(path.join(root,p),"utf8");
const planText=await read("packages/deep-engine/fixtures/j2-csm-timing-v1.json");
const fixtureText=await read("packages/deep-engine/fixtures/j2-csm-parity-v1.json");
const plan=JSON.parse(planText),fixture=JSON.parse(fixtureText),planHash=hash(planText),fixtureHash=hash(fixtureText);
const source=await read("packages/deep-engine/wgsl/cascadedShadowMath.wgsl")+"\n"+
  await read("packages/deep-engine-native/assets/shaders/native_cascaded_shadow_v1.wgsl");
const entry=await read("packages/deep-engine/fixtures/j2-csm-timing-entry.wgsl");
await mkdir(out,{recursive:true});
await rm(path.join(out,"evidence.json"),{force:true});
const bundled=await build({entryPoints:[path.join(root,"packages/deep-engine/lab/j2CsmTimingProbe.ts")],
  bundle:true,format:"esm",platform:"browser",write:false,metafile:true});
const paths=new Set(Object.keys(bundled.metafile.inputs).map(p=>path.resolve(p)));
for(const p of ["scripts/j2-csm-timing-parity.mjs","scripts/lib/j2CsmTimingParity.mjs",
  "packages/deep-engine/src/benchmarkWindowComparison.ts","packages/deep-engine/src/benchmarkSampleSchema.ts",
  "packages/deep-engine-native/src/csm_sampling_gpu_timing_tests.rs","packages/deep-engine-native/src/csm_sampling_timing_resources.rs",
  "packages/deep-engine-native/src/telemetry_gpu.rs","packages/deep-engine-native/src/telemetry.rs",
  "packages/deep-engine-native/tests/support/j2_csm_oracle.rs","packages/deep-engine-native/tests/support/lod_draw_readback.rs",
  "packages/deep-engine-native/src/shader_package/hash.rs","packages/deep-engine-native/src/main.rs",
  "packages/deep-engine/fixtures/j2-csm-parity-v1.json","packages/deep-engine/fixtures/j2-csm-timing-v1.json",
  "packages/deep-engine/fixtures/j2-csm-timing-entry.wgsl","packages/deep-engine/wgsl/cascadedShadowMath.wgsl",
  "packages/deep-engine-native/assets/shaders/native_cascaded_shadow_v1.wgsl","packages/deep-engine-native/Cargo.toml",
  "packages/deep-engine-native/Cargo.lock","pnpm-lock.yaml"])paths.add(path.join(root,p));
async function snapshot(){return Object.fromEntries(await Promise.all([...paths].sort().map(async p=>[path.relative(root,p).replaceAll("\\","/"),hash(await readFile(p))])));}
const before=await snapshot();
if(!compare){
  await rm(path.join(out,"web.json"),{force:true});
  if(!webOnly){
    await rm(path.join(out,"native.json"),{force:true});
    const native=spawnSync("cargo",["test","--manifest-path","packages/deep-engine-native/Cargo.toml","--locked",
      "--bin","deep-engine-native","j2_b4_actual_native_csm_timing","--","--ignored","--nocapture"],
      {cwd:root,encoding:"utf8",windowsHide:true,timeout:600000,maxBuffer:16*1024*1024});
    const log=(native.stdout??"")+(native.stderr??"");await writeFile(path.join(out,"native.log"),log);
    if(native.error||native.status!==0||!/test .*j2_b4_actual_native_csm_timing \.\.\. ok/.test(log)
      ||!/test result: ok\. [1-9]\d* passed/.test(log))throw Error("Actual Native timing test failed; see csm-timing/native.log");
  }
  await writeFile(path.join(out,"probe.mjs"),bundled.outputFiles[0].contents);
  const css=await read("apps/web/src/styles/base.css");
  const server=createServer(async(req,res)=>{
    if(req.url==="/probe.mjs"){res.setHeader("Content-Type","text/javascript");res.end(await readFile(path.join(out,"probe.mjs")));}
    else{res.setHeader("Content-Type","text/html; charset=utf-8");res.end(`<html data-theme="dark"><head><style>${css}</style></head><body style="padding:32px;background:var(--bg-0);color:var(--text-strong)"><h1>CSM 接收采样计时</h1><p>同设备 · 五个成对窗口 · GPU 时间戳</p><canvas id="gpu" width="128" height="128" style="width:128px;height:128px"></canvas><pre id="result"></pre></body></html>`);}
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));let browser;
  try{
    const {chromium}=require("../apps/cloud-render-worker/node_modules/playwright-core");
    browser=await chromium.launch({executablePath:process.env.BIM_STUDIO_CHROME_PATH??"C:/Program Files/Google/Chrome/Application/chrome.exe",
      headless:true,args:["--enable-unsafe-webgpu"]});
    const page=await browser.newPage({viewport:{width:1920,height:1080}});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const web=await page.evaluate(async args=>(await import("/probe.mjs")).runJ2CsmTimingProbe(
      document.querySelector("#gpu"),args.source,args.entry,args.plan,args.fixture),{source,entry,plan,fixture});
    Object.assign(web,{planHash,fixtureHash});await writeFile(path.join(out,"web.json"),JSON.stringify(web,null,2)+"\n");
    await page.evaluate(result=>document.querySelector("#result").textContent=JSON.stringify(result.results.map(r=>({id:r.id,
      gpu:r.comparison.find(c=>c.channel==="gpu-timestamp")})),null,2),web);
    await page.screenshot({path:path.join(out,"frame-0.png")});
    await page.screenshot({path:path.join(out,"frame-1.png")});
  }finally{try{await browser?.close();}finally{await new Promise(resolve=>server.close(resolve));}}
}
const after=await snapshot();if(JSON.stringify(before)!==JSON.stringify(after))throw Error("CSM timing source identity changed during run");
if(webOnly){console.log(JSON.stringify({scope:"web-only-current-timing",currentRun:false,path:path.join(out,"web.json")}));}
else{
  const evidence=await compareCsmTimings(plan,fixtureHash,planHash,JSON.parse(await readFile(path.join(out,"web.json"),"utf8")),
    JSON.parse(await readFile(path.join(out,"native.json"),"utf8")));
  const result={...evidence,currentRun:!compare,sourceIdentity:before,execution:compare?"prior receipts compared without GPU execution":"fresh native and Web function timing"};
  await writeFile(path.join(out,"evidence.json"),JSON.stringify(result,null,2)+"\n");
  console.log(JSON.stringify({passed:result.passed,timingComplete:result.timingComplete,currentRun:result.currentRun,results:result.results},null,2));
}
