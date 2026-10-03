import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compareDisplayFrames, compareDisplayLibraries } from "./lib/j3DisplayParity.mjs";
import { snapshotLayerSources, requireUnchangedLayerSources } from "./lib/j3LayerSourceIdentity.mjs";

const root = fileURLToPath(new URL("../",import.meta.url)), require = createRequire(import.meta.url);
const out = path.join(root,"test-output/interrupted-0930/display-parity");
await mkdir(out,{recursive:true});
await rm(path.join(out,"evidence.json"),{force:true});
const sourceFiles = ["scripts/j3-display-parity.mjs", "scripts/lib/j3DisplayParity.mjs",
  "packages/deep-engine/lab/displayBackendParityProbe.ts", "packages/deep-engine/fixtures/display-parity-v1.json",
  "packages/deep-engine-native/tests/compact_forward_output_gpu.rs", "packages/deep-engine-native/tests/support/j3_output_dump.rs"];
const before = await snapshotLayerSources(sourceFiles);
const fixturePath=path.join(root,"packages/deep-engine/fixtures/display-parity-v1.json");
const fixture=JSON.parse(await readFile(fixturePath,"utf8"));
const { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({entryPoints:[path.join(root,"packages/deep-engine/lab/displayBackendParityProbe.ts")],
  outfile:path.join(out,"probe.mjs"),bundle:true,format:"esm",platform:"browser"});
const server=createServer(async(request,response)=>{
  if(request.url==="/probe.mjs") response.setHeader("Content-Type","text/javascript");
  response.end(request.url==="/probe.mjs"? await readFile(path.join(out,"probe.mjs")):
    '<html><body><canvas id="pixels" width="32" height="32" style="width:512px;height:512px;image-rendering:pixelated"></canvas></body></html>');
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const {chromium}=require("../apps/cloud-render-worker/node_modules/playwright-core");
let browser;
try {
  browser=await chromium.launch({executablePath:process.env.BIM_STUDIO_CHROME_PATH??"C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless:true,args:["--enable-unsafe-webgpu"]});
  const page=await browser.newPage({viewport:{width:800,height:640}});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const web=[];
  for(let round=1;round<=2;round++) {
    web.push(await page.evaluate(async()=> (await import("/probe.mjs")).runDisplayParity()));
    await page.evaluate(pixels=>{
      const c=document.querySelector("canvas");c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(pixels),32,32),0,0);
    },web.at(-1).output);
    await page.screenshot({path:path.join(out,`web-round-${round}.png`)});
  }
  const nativePath=path.join(out,"native.json");
  await rm(nativePath,{force:true});
  const cargo=spawnSync("cargo",["test","--manifest-path","packages/deep-engine-native/Cargo.toml","--locked","--test","compact_forward_output_gpu",
    "j3_gate_d_shared_output_dump","--","--ignored","--nocapture"],
    {cwd:root,env:{...process.env,J3_NATIVE_OUTPUT_PATH:nativePath},encoding:"utf8",windowsHide:true,timeout:600000});
  await writeFile(path.join(out,"native.log"),(cargo.stdout??"")+ (cargo.stderr??""));
  const nativeLog=(cargo.stdout??"")+(cargo.stderr??"");
  if(cargo.error||cargo.status!==0||!/test j3_output_dump::j3_gate_d_shared_output_dump \.\.\. ok/.test(nativeLog)
    ||!/test result: ok\. [1-9]\d* passed/.test(nativeLog)) throw Error(`Native output leg failed or did not execute (${cargo.status}); see ${out}/native.log`);
  const native=JSON.parse(await readFile(nativePath,"utf8"));
  assert.deepEqual(native.fixture,fixture,"native must consume exactly the current shared manifest");
  assert.equal(native.width,fixture.width); assert.equal(native.height,fixture.height);
  assert.equal(native.frames.length,2); assert.equal(native.gpuErrors,0);
  for(let round=1;round<=2;round++) {
    await page.evaluate(pixels=>{
      const c=document.querySelector("canvas"); c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(pixels),32,32),0,0);
    },native.frames[round-1]);
    await page.screenshot({path:path.join(out,`native-round-${round}.png`)});
  }
  const results=web.map((r,index)=>({round:index+1,output:compareDisplayFrames(r.output,native.frames[index],fixture),
    libraries:r.libraries.map(l=>({settings:l.settings,...compareDisplayLibraries(l.webgpu,l.webgl,fixture)})),gpuErrors:r.errors}));
  const stable=JSON.stringify(web[0])===JSON.stringify(web[1]) && JSON.stringify(native.frames[0])===JSON.stringify(native.frames[1]);
  const passed=stable && results.every(r=>r.output.passed&&r.libraries.every(l=>l.passed)&&r.gpuErrors.length===0);
  const hash = bytes=>createHash("sha256").update(bytes).digest("hex");
  requireUnchangedLayerSources(before,await snapshotLayerSources(sourceFiles));
  const evidence={scope:fixture.scope,passed,stable,currentRun:true,sourceIdentity:before,
    execution:"fresh named Native output test plus two Web rounds",results,identities:{fixture:hash(await readFile(fixturePath)),
    web:web[0].identities,nativeOutput:hash(native.shaderSource)},legalDifferences:fixture.legalDifferences,excluded:fixture.excluded,
    note:"Output stage only; scene, HDR lighting, depth/shadow, resource lifecycle are not certified by this gate."};
  await writeFile(path.join(out,"evidence.json"),JSON.stringify(evidence,null,2));
  await writeFile(path.join(out,"web.json"),JSON.stringify(web));
  console.log(JSON.stringify(evidence,null,2)); if(!passed)process.exitCode=1;
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
