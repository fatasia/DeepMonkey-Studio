import {createServer} from "node:http";
import {createRequire} from "node:module";
import {readFile,writeFile,mkdir,rm,readdir} from "node:fs/promises";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import path from "node:path";
import {requireTextureCoverageNativeRun,validateTextureCoverageHost,requireStableTextureFresh,compareTextureCoveragePair} from "./lib/j3TextureCoverageParity.mjs";
const root=fileURLToPath(new URL("../",import.meta.url)),require=createRequire(import.meta.url),out=path.join(root,"test-output/interrupted-0930/texture-coverage");
const args=process.argv.slice(2),prepare=args.includes("--prepare"),historical=args.includes("--compare");
if(args.some(a=>a!=="--prepare"&&a!=="--compare")||(prepare&&historical))throw Error("Use default fresh dual host, --prepare CPU only, or --compare historical");
const hash=v=>createHash("sha256").update(v).digest("hex");
await mkdir(out,{recursive:true});if(!prepare)await rm(path.join(out,"evidence.json"),{force:true});
const fixtureText=await readFile(path.join(root,"packages/deep-engine/fixtures/j3-texture-coverage-v1.json"),"utf8"),fixture=JSON.parse(fixtureText),profileHash=hash(fixtureText);
const manifest=JSON.parse(await readFile(path.join(root,"packages/deep-engine/fixtures/j3-hdr-flat-normal-v1.json"),"utf8")),source=JSON.parse(await readFile(path.join(root,manifest.sourceFixture),"utf8"));
const {build}=require("../packages/deep-engine/node_modules/esbuild");
const cpu=await build({absWorkingDir:root,entryPoints:["packages/deep-engine/lab/j3TextureCoverageFixture.ts"],outfile:path.join(out,"cpu.mjs"),bundle:true,platform:"node",format:"esm",metafile:true});
const web=await build({absWorkingDir:root,entryPoints:["packages/deep-engine/lab/j3TextureCoverageProbe.ts"],outfile:path.join(out,"probe.mjs"),bundle:true,platform:"browser",format:"esm",metafile:true});
const {buildTextureCoveragePlan,textureCoverageExpectedShaderHash}=await import(pathToFileURL(path.join(out,"cpu.mjs"))),plan={...buildTextureCoveragePlan(source,manifest,fixture),profileHash};
const inputText=JSON.stringify(plan),inputHash=hash(inputText),inputPath=path.join(out,"input.json"),nativePath=path.join(out,"native.json");
await writeFile(inputPath,inputText);
const files=new Set([...Object.keys(cpu.metafile.inputs),...Object.keys(web.metafile.inputs),"scripts/j3-texture-coverage-parity.mjs","scripts/lib/j3TextureCoverageParity.mjs",
  "packages/deep-engine/fixtures/j3-texture-coverage-v1.json","packages/deep-engine/fixtures/j3-hdr-flat-normal-v1.json",manifest.sourceFixture,
  "packages/deep-engine-native/tests/support/j3_texture_coverage.rs","packages/deep-engine-native/tests/support/shader_material_renderer.rs","packages/deep-engine-native/tests/support/shader_material_observers.rs",
  "packages/deep-engine-native/tests/gpu_shader_material_draw.rs"]);
async function sourceFiles(dir){for(const name of await readdir(path.join(root,dir),{withFileTypes:true})){
  const p=path.posix.join(dir,name.name);if(name.isDirectory()){if(name.name!=="app")await sourceFiles(p);}else if(/\.(rs|wgsl)$/.test(name.name))files.add(p);
}}
await sourceFiles("packages/deep-engine-native/src");await sourceFiles("packages/deep-engine-native/assets/shaders");await sourceFiles("packages/deep-engine/wgsl");
async function identity(){return Object.fromEntries(await Promise.all([...files].sort().map(async p=>[p,hash(await readFile(path.join(root,p)))])));}
const before=await identity();
if(prepare){
  const evidencePath=path.join(out,"evidence.json");let evidence;
  try{const stale=JSON.parse(await readFile(evidencePath,"utf8"));
    if(stale.inputHash!==inputHash){await rm(evidencePath,{force:true});evidence={disposition:"invalidated-stale-input",staleInputHash:stale.inputHash??null};}
    else evidence={disposition:"retained-same-input"};}
  catch{await rm(evidencePath,{force:true}).catch(()=>{});evidence={disposition:"invalidated-unreadable"};}
  console.log(JSON.stringify({prepared:true,currentRun:false,inputPath,profileHash,inputHash,evidence,
    cameras:plan.cameras.map(c=>({id:c.id,points:c.points.length,stable:fixture.scenarios.map(id=>[id,c.points.filter(p=>p.byScenario[id].stable).length])})),nativeTest:"j3_actual_texture_uv_coverage",framesPerFresh:28}));process.exit(0);}
let browser,server,hosts=[];
try{
  if(!historical){
    for(const name of ["native.json","web-0.json","web-1.json"])await rm(path.join(out,name),{force:true});
    await new Promise((resolve,reject)=>{
      const child=spawn("cargo",["test","--locked","--test","gpu_shader_material_draw","j3_actual_texture_uv_coverage","--","--ignored"],
        {cwd:path.join(root,"packages/deep-engine-native"),env:{...process.env,J3_TEXTURE_INPUT_PATH:inputPath,J3_TEXTURE_NATIVE_OUTPUT:nativePath},stdio:["ignore","pipe","pipe"]});
      let log="";for(const stream of [child.stdout,child.stderr])stream.on("data",v=>{log+=v;process.stdout.write(v);});child.once("error",reject);
      child.once("close",async code=>{try{await writeFile(path.join(out,"native-run.log"),log);requireTextureCoverageNativeRun(log,code);resolve();}catch(e){reject(e);}});
    });
    const css=await readFile(path.join(root,"apps/web/src/styles/base.css"),"utf8");
    server=createServer(async(req,res)=>{try{
      if(req.url==="/probe.mjs"){res.setHeader("Content-Type","text/javascript");res.end(await readFile(path.join(out,"probe.mjs")));}
      else{res.setHeader("Content-Type","text/html; charset=utf-8");res.end(`<html data-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head><body style="background:var(--bg-0);color:var(--text-strong);padding:32px"><h1>Gate D · 纹理与覆盖</h1><p>同 runtime 包 · 原85点 · 两相机 · sRGB / linear / UV1 / MASK / 单层 BLEND</p><canvas width="128" height="128" style="width:640px;height:640px;image-rendering:pixelated"></canvas><p id="case">正式材质实际帧</p></body></html>`);}
    }catch(e){res.statusCode=500;res.end(String(e));}});
    await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
    const {chromium}=require("../apps/cloud-render-worker/node_modules/playwright-core");
    browser=await chromium.launch({headless:true,executablePath:process.env.BIM_STUDIO_CHROME_PATH??"C:/Program Files/Google/Chrome/Application/chrome.exe",args:["--enable-unsafe-webgpu"]});
    for(let fresh=0;fresh<2;fresh++){
      const page=await browser.newPage({viewport:{width:1920,height:1080},reducedMotion:"reduce"}),errors=[];
      try{
        page.on("pageerror",e=>errors.push(String(e)));await page.exposeFunction("captureTextureFrame",async(id,round)=>{
          if(id==="oblique-blend"&&round===0)await page.screenshot({path:path.join(out,`frame-fresh-${fresh}.png`)});
        });await page.goto(`http://127.0.0.1:${server.address().port}`);
        const actual=await page.evaluate(async plan=>(await import("/probe.mjs")).runTextureCoverageProbe(document.querySelector("canvas"),plan,async(id,round)=>{
          document.getElementById("case").textContent=id;await window.captureTextureFrame(id,round);
        }),plan);
        if(errors.length)throw Error(errors.join("\n"));const host={...actual,freshInstance:fresh,inputHash,profileHash};hosts.push(host);await writeFile(path.join(out,`web-${fresh}.json`),JSON.stringify(host));
      }finally{await page.close();}
    }
  }else for(let fresh=0;fresh<2;fresh++)hosts.push(JSON.parse(await readFile(path.join(out,`web-${fresh}.json`),"utf8")));
  const native=JSON.parse(await readFile(nativePath,"utf8")),webSourceHash=textureCoverageExpectedShaderHash;
  const nativeMesh=await readFile(path.join(root,"packages/deep-engine-native/assets/shaders/native_mesh_v1.wgsl"),"utf8");
  if(!native.source?.startsWith(nativeMesh+"\n"))throw Error("Native actual module does not contain current formal mesh source");
  const receipt={inputHash,profileHash,webSourceHash};
  const summaries=[validateTextureCoverageHost(plan,native,receipt),...hosts.map(h=>validateTextureCoverageHost(plan,h,receipt))];
  if(hosts[0].freshInstance!==0||hosts[1].freshInstance!==1)throw Error("Web fresh identities duplicated");requireStableTextureFresh(hosts[0],hosts[1]);
  const pairs=native.runs.map((r,i)=>compareTextureCoveragePair(plan,r,hosts[i]));
  const after=await identity();if(JSON.stringify(before)!==JSON.stringify(after))throw Error("Consumed texture source changed during run");
  const evidence={passed:true,currentRun:!historical,execution:historical?"historical comparison only":"two fresh devices per host, each28actualframes",profileHash,inputHash,sourceIdentity:before,summaries,pairs,
    excluded:["overlapping transparency","linear/mip/aniso sampling","normal-mapped materials","texture arrays","layered materials","ray tracing","driver loss"]};
  await writeFile(path.join(out,"evidence.json"),JSON.stringify(evidence,null,2));console.log(JSON.stringify({passed:true,currentRun:evidence.currentRun,pairs,summaries}));
}catch(e){
  await rm(path.join(out,"evidence.json"),{force:true});if(!historical)await rm(nativePath,{force:true});throw e;
}finally{try{await browser?.close();}finally{if(server?.listening)await new Promise(resolve=>server.close(resolve));}}
