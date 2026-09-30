import {createServer} from "node:http";
import {createRequire} from "node:module";
import {readFile,writeFile,mkdir,rm} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
import path from "node:path";
import {compareBloomTextures,bloomFixtureHash} from "./lib/j3BloomTextureParity.mjs";
const root=fileURLToPath(new URL("../",import.meta.url)),require=createRequire(import.meta.url),output=path.join(root,"test-output/interrupted-0930/bloom-texture");
const flags=new Set(process.argv.slice(2));
if(flags.size>1||[...flags].some(flag=>!["--compare","--web-only"].includes(flag)))throw Error("Choose default, --compare or --web-only");
const compare=flags.has("--compare"),webOnly=flags.has("--web-only");
await mkdir(output,{recursive:true});await rm(path.join(output,"evidence.json"),{force:true});
const fixtureText=await readFile(path.join(root,"packages/deep-engine/fixtures/j3-bloom-texture-v1.json"),"utf8"),fixture=JSON.parse(fixtureText),fixtureHash=bloomFixtureHash(fixtureText);
const {build}=require("../packages/deep-engine/node_modules/esbuild");
const cpu=await build({absWorkingDir:root,entryPoints:["packages/deep-engine/lab/j3BloomTextureReference.ts"],outfile:path.join(output,"reference.mjs"),bundle:true,format:"esm",platform:"node",metafile:true});
const webBuild=await build({absWorkingDir:root,entryPoints:["packages/deep-engine/lab/j3BloomTextureProbe.ts"],outfile:path.join(output,"probe.mjs"),bundle:true,format:"esm",platform:"browser",metafile:true,conditions:["development"]});
const {bloomTextureInput,bloomTextureBits,webBloomTextureReference,nativeBloomTextureReference}=await import(pathToFileURL(path.join(output,"reference.mjs")));
const plans=fixture.cases.map(id=>{
  const source=bloomTextureInput(id,fixture.width,fixture.height),web=webBloomTextureReference(source,fixture.web),native=nativeBloomTextureReference(source,fixture.native);
  return {id,source,web:Array.from(web.pixels),native:{blurred:Array.from(native.blurred.pixels),display:Array.from(native.display.pixels)}};
});
const hash=value=>createHash("sha256").update(value).digest("hex");
for(const plan of plans){plan.inputHash=hash(Array.from(bloomTextureBits(plan.source)).join(","));delete plan.source;}
await writeFile(path.join(output,"cpu-plan.json"),JSON.stringify({fixtureHash,fixture,plans}));
const files=[...Object.keys(cpu.metafile.inputs),...Object.keys(webBuild.metafile.inputs),
  "packages/deep-engine/fixtures/j3-bloom-texture-v1.json","packages/deep-engine-native/tests/j3_bloom_texture_gpu.rs",
  ...["bloom_pass.rs","bloom_pipeline.rs","output_pass.rs","bloom.rs","output_color_profile.rs","half_float.rs","half_decode.rs","mesh_abi.rs","shader_package/hash.rs"].map(f=>"packages/deep-engine-native/src/"+f),
  ...["native_bloom_v1.wgsl","native_output_v1.wgsl","native_output_bloom_v1.wgsl","native_output_fog_v1.wgsl","native_output_bloom_fog_v1.wgsl","native_output_color.wgsl"].map(f=>"packages/deep-engine-native/assets/shaders/"+f),
  ...["bloomPrefilter.wgsl","displayColor.wgsl","fogOpticalDepth.wgsl"].map(f=>"packages/deep-engine/wgsl/"+f),
  "scripts/j3-bloom-texture-parity.mjs","scripts/lib/j3BloomTextureParity.mjs","apps/web/src/styles/base.css","packages/deep-engine/package.json","packages/deep-engine-native/Cargo.toml","packages/deep-engine-native/Cargo.lock","pnpm-lock.yaml"];
async function identity(){return Object.fromEntries(await Promise.all([...new Set(files)].sort().map(async file=>[file,hash(await readFile(path.join(root,file)))])));}
const before=await identity();
if(!compare){
  for(let run=0;run<2;run++)await rm(path.join(output,`web-${run}.json`),{force:true});
  if(!webOnly){
    await rm(path.join(output,"native.json"),{force:true});
    const child=spawnSync("cargo",["test","--manifest-path","packages/deep-engine-native/Cargo.toml","--locked","--test","j3_bloom_texture_gpu","j3_gate_d_actual_bloom_textures","--","--ignored","--nocapture"],
      {cwd:root,encoding:"utf8",windowsHide:true,timeout:600000,maxBuffer:16*1024*1024});
    const log=(child.stdout??"")+(child.stderr??"");await writeFile(path.join(output,"native.log"),log);
    if(child.error||child.status!==0||!/test j3_gate_d_actual_bloom_textures \.\.\. ok/.test(log)||!/test result: ok\. [1-9]\d* passed/.test(log))throw Error("Actual Native Bloom texture gate failed; native.log retained");
  }
  const css=await readFile(path.join(root,"apps/web/src/styles/base.css"),"utf8");
  const server=createServer(async(req,res)=>{
    if(req.url==="/probe.mjs"){res.setHeader("Content-Type","text/javascript");res.end(await readFile(path.join(output,"probe.mjs")));}
    else{res.setHeader("Content-Type","text/html; charset=utf-8");res.end(`<html data-theme="dark"><head><style>${css}</style></head><body style="background:var(--bg-0);color:var(--text-strong)"><h1>Bloom实际纹理数值门</h1></body></html>`);}
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));let browser;
  try{
    const {chromium}=require("../apps/cloud-render-worker/node_modules/playwright-core");
    browser=await chromium.launch({headless:true,executablePath:process.env.BIM_STUDIO_CHROME_PATH??"C:/Program Files/Google/Chrome/Application/chrome.exe",args:["--enable-unsafe-webgpu"]});
    for(let run=0;run<2;run++){
      const page=await browser.newPage({viewport:{width:1920,height:1080},reducedMotion:"reduce"}),errors=[];page.on("pageerror",error=>errors.push(String(error)));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const host=await page.evaluate(async f=>(await import("/probe.mjs")).runJ3BloomTextureProbe(f),fixture);
      if(errors.length)throw Error(errors.join("\n"));
      await writeFile(path.join(output,`web-${run}.json`),JSON.stringify({...host,fixtureHash,freshInstance:run}));await page.close();
    }
  }finally{try{await browser?.close();}finally{await new Promise(resolve=>server.close(resolve));}}
}
const native=JSON.parse(await readFile(path.join(output,"native.json"),"utf8"));
const web=await Promise.all([0,1].map(async run=>JSON.parse(await readFile(path.join(output,`web-${run}.json`),"utf8"))));
if([native,...web].some(host=>host.fixtureHash!==fixtureHash))throw Error("Bloom frozen fixture identity mismatch");
const results=web.map(host=>compareBloomTextures(fixture,plans,host,native));
for(let i=0;i<web[0].frames.length;i++)if(web[0].frames[i].rgbaHash!==web[1].frames[i].rgbaHash)throw Error("Actual Bloom two fresh Web devices differ");
const after=await identity();if(JSON.stringify(before)!==JSON.stringify(after))throw Error("Consumed Bloom sources changed during run");
const evidence={passed:true,stable:true,currentRun:!compare&&!webOnly,fixtureHash,web:results,sourceIdentity:before,
  execution:compare?"stored actual receipts":webOnly?"two fresh Web devices and stored Native receipt":"fresh named Native plus two fresh Web devices",
  scope:results[0].scope,pixelsCompared:results.reduce((n,r)=>n+r.pixelsCompared,0),excluded:results[0].excluded};
await writeFile(path.join(output,"evidence.json"),JSON.stringify(evidence,null,2));
console.log(JSON.stringify({passed:true,currentRun:evidence.currentRun,pixelsCompared:evidence.pixelsCompared,comparisons:results.reduce((n,r)=>n+r.comparisons.length,0)}));
