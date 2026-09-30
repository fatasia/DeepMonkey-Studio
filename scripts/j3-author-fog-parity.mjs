import {createServer} from "node:http";
import {createRequire} from "node:module";
import {readFile,writeFile,mkdir,rm,readdir} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
import path from "node:path";
import {compareAuthorFog} from "./lib/j3AuthorFogParity.mjs";
const root=fileURLToPath(new URL("../",import.meta.url)),require=createRequire(import.meta.url);
const output=path.join(root,"test-output/interrupted-0930/author-fog");
const flags=new Set(process.argv.slice(2));
if(flags.size>1||[...flags].some(flag=>!["--compare","--web-only"].includes(flag)))throw Error("Choose default, --compare or --web-only");
const compare=flags.has("--compare"),webOnly=flags.has("--web-only");
await mkdir(output,{recursive:true});await rm(path.join(output,"evidence.json"),{force:true});
const manifest=JSON.parse(await readFile(path.join(root,"packages/deep-engine/fixtures/j3-hdr-flat-normal-v1.json"),"utf8"));
const source=JSON.parse(await readFile(path.join(root,manifest.sourceFixture),"utf8"));
const profileText=await readFile(path.join(root,"packages/deep-engine/fixtures/j3-author-fog-v1.json"),"utf8"),profile=JSON.parse(profileText);
const profileHash=createHash("sha256").update(profileText).digest("hex");
const own=["packages/deep-engine/fixtures/j3-author-fog-v1.json","packages/deep-engine/fixtures/j3-hdr-flat-normal-v1.json",
  "packages/deep-engine/lab/j3AuthorFogMatrix.ts","packages/deep-engine/lab/j3AuthorFogProbe.ts","packages/deep-engine/lab/j3NormalShadowMatrix.ts",
  "packages/deep-engine-native/tests/support/j3_author_fog.rs","packages/deep-engine-native/tests/support/j3_hdr_frame.rs",
  "packages/deep-engine-native/tests/support/shader_material_renderer.rs","packages/deep-engine-native/tests/support/shader_material_observers.rs",
  "packages/deep-engine-native/tests/gpu_shader_material_draw.rs","scripts/lib/j3AuthorFogParity.mjs","scripts/j3-author-fog-parity.mjs",manifest.sourceFixture];
const {build}=require("../packages/deep-engine/node_modules/esbuild");
const cpuBundle=await build({absWorkingDir:root,entryPoints:[path.join(root,"packages/deep-engine/lab/j3AuthorFogMatrix.ts")],outfile:path.join(output,"cpu-plan.mjs"),
  bundle:true,format:"esm",platform:"node",metafile:true});
const webBundle=await build({absWorkingDir:root,entryPoints:[path.join(root,"packages/deep-engine/lab/j3AuthorFogProbe.ts")],outfile:path.join(output,"probe.mjs"),
  bundle:true,format:"esm",platform:"browser",metafile:true});
// Hash exactly the Web bundle dependency closure; unrelated editor/new Gaussian files are outside this gate.
own.push(...Object.keys(cpuBundle.metafile.inputs),...Object.keys(webBundle.metafile.inputs),"apps/web/src/styles/base.css",
  "package.json","pnpm-lock.yaml","packages/deep-engine/package.json","packages/deep-engine-native/Cargo.toml","packages/deep-engine-native/Cargo.lock","packages/deep-engine-native/build.rs");
async function visit(directory){for(const entry of await readdir(path.join(root,directory),{withFileTypes:true})){
  const file=directory+"/"+entry.name;if(entry.isDirectory())await visit(file);else if(entry.isFile())own.push(file);}}
// Native production is frozen by its owner; retain its complete source/assets identity, including canonical kernels.
for(const directory of ["packages/deep-engine-native/src","packages/deep-engine-native/assets","packages/deep-engine/wgsl"])await visit(directory);
async function identity(){return Object.fromEntries(await Promise.all([...new Set(own)].sort().map(async file=>
  [file,createHash("sha256").update(await readFile(path.join(root,file))).digest("hex")])));}
const before=await identity();
const {buildJ3AuthorFogMatrix}=await import(pathToFileURL(path.join(output,"cpu-plan.mjs")));
const plan={...buildJ3AuthorFogMatrix(source,manifest,profile),profileHash};
await writeFile(path.join(output,"cpu-plan.json"),JSON.stringify(plan));
if(!compare){
  for(let run=0;run<2;run++)await rm(path.join(output,`web-${run}.json`),{force:true});
  if(!webOnly){
    await rm(path.join(output,"native.json"),{force:true});
    const cargo=spawnSync("cargo",["test","--manifest-path","packages/deep-engine-native/Cargo.toml","--locked",
      "--test","gpu_shader_material_draw","j3_gate_d_actual_author_fog","--","--ignored","--nocapture"],
      {cwd:root,encoding:"utf8",windowsHide:true,timeout:600000,maxBuffer:16*1024*1024});
    const log=(cargo.stdout??"")+(cargo.stderr??"");await writeFile(path.join(output,"native.log"),log);
    if(cargo.error||cargo.status!==0||!/test j3_author_fog::j3_gate_d_actual_author_fog \.\.\. ok/.test(log)
      ||!/test result: ok\. [1-9]\d* passed/.test(log))throw Error("Native authored fog actual gate failed; diagnostic native.json/native.log retained");
  }
  const css=await readFile(path.join(root,"apps/web/src/styles/base.css"),"utf8");
  const server=createServer(async(req,res)=>{
    if(req.url==="/probe.mjs"){res.setHeader("Content-Type","text/javascript");res.end(await readFile(path.join(output,"probe.mjs")));}
    else{res.setHeader("Content-Type","text/html; charset=utf-8");res.end(`<html data-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head><body style="background:var(--bg-0);color:var(--text-strong);padding:32px"><h1>共同作者 exp2 雾</h1><p>同一场景 · 两相机 · 原85点 · 材质雾开关</p><canvas width="128" height="128" style="width:512px;height:512px;image-rendering:pixelated"></canvas></body></html>`);}
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));let browser;
  try{
    const {chromium}=require("../apps/cloud-render-worker/node_modules/playwright-core");
    browser=await chromium.launch({headless:true,executablePath:process.env.BIM_STUDIO_CHROME_PATH??"C:/Program Files/Google/Chrome/Application/chrome.exe",args:["--enable-unsafe-webgpu"]});
    for(let run=0;run<2;run++) {
    const page=await browser.newPage({viewport:{width:1920,height:1080},reducedMotion:"reduce"}),errors=[];
    page.on("pageerror",e=>errors.push(String(e)));
    await page.exposeFunction("captureAuthorFog",async(id,round)=>{if(id==="oblique-density-high"&&round===0)await page.screenshot({path:path.join(output,`frame-${id}-fresh-${run}.png`)});});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const web=await page.evaluate(async a=>(await import("/probe.mjs")).runJ3AuthorFogProbe(document.querySelector("canvas"),a.source,a.manifest,a.profile,
      (id,round)=>window.captureAuthorFog(id,round)),{source,manifest,profile});
    if(errors.length)throw Error(errors.join("\n"));
    await writeFile(path.join(output,`web-${run}.json`),JSON.stringify({...web,profileHash,freshInstance:run}));
    await page.close();
    }
  }finally{try{await browser?.close();}finally{await new Promise(resolve=>server.close(resolve));}}
}
const web=await Promise.all([0,1].map(async run=>JSON.parse(await readFile(path.join(output,`web-${run}.json`),"utf8"))));
const native=webOnly?null:JSON.parse(await readFile(path.join(output,"native.json"),"utf8"));
if([...web,...(native?[native]:[])].some(h=>h.profileHash!==profileHash))throw Error("Author fog profile identity mismatch");
const results=web.map(host=>compareAuthorFog(plan,host,native??host));
for(let i=0;i<web[0].frames.length;i++)if(web[0].frames[i].rgbaHash!==web[1].frames[i].rgbaHash)throw Error("Author fog two fresh Web devices differ");
const result={...results[0],pointsCompared:results.reduce((n,r)=>n+r.pointsCompared,0),
  maxCpuError:Math.max(...results.map(r=>r.maxCpuError)),maxCrossError:Math.max(...results.map(r=>r.maxCrossError))};
const after=await identity();if(JSON.stringify(before)!==JSON.stringify(after))throw Error("Author fog sources changed during run");
const evidence={...result,currentRun:!compare&&!webOnly,execution:compare?"prior receipts":webOnly?"two fresh Web devices only; Native not executed":"fresh named Native and two fresh Web devices production frames",
  web:results,sourceIdentity:before,...(webOnly?{scope:"actual-Web-only-authored-exp2-HDR",excluded:[...result.excluded,"Native actual HDR parity"]}:{})};
await writeFile(path.join(output,"evidence.json"),JSON.stringify(evidence,null,2));
console.log(JSON.stringify({passed:evidence.passed,currentRun:evidence.currentRun,pointsCompared:evidence.pointsCompared,maxCpuError:evidence.maxCpuError,maxCrossError:evidence.maxCrossError}));
