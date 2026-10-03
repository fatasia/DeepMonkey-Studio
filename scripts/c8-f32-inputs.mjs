// Ignored scratch orchestration; GPU execution belongs to root after the formal source freeze lifts.
import { createServer } from 'node:http';
import { readFile,writeFile,mkdir,rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url),hash=v=>createHash('sha256').update(v).digest('hex');
const out=path.join(root,'test-output/c8-f32-inputs-20261001/gpu-output'),modes=['normal','view','geometry-normal','dx','dy','brdf-dots'];
await mkdir(out,{recursive:true});await rm(path.join(out,'evidence.json'),{force:true});
const files=['packages/deep-engine/lab/c8F32InputsShader.ts','packages/deep-engine/lab/c8F32InputsProbe.ts','scripts/c8-f32-inputs.mjs',
 'packages/deep-engine/lab/c8F32MrtShader.ts','packages/deep-engine/lab/c8F32MrtDevice.ts','packages/deep-engine/lab/c8FragmentObservablesShader.ts',
 'packages/deep-engine/lab/c8SharedSceneProbe.ts','packages/deep-engine/lab/c8SharedSceneReadback.ts','packages/deep-engine/lab/c8SharedSceneFixture.ts',
 'packages/deep-engine/src/webgpu/pbrShader.ts','packages/deep-engine/src/webgpu/frameCaptureReadback.ts','packages/deep-engine/src/webgpu/pipelines.ts',
 'packages/deep-engine/src/webgpu/pbrOpaquePass.ts','packages/deep-engine/wgsl/brdfDirectLighting.wgsl','apps/web/src/viewer/threeMaterialMath.ts'];
const sourceIdentity=Object.fromEntries(await Promise.all(files.map(async f=>[f,hash(await readFile(path.join(root,f)))])));
const {build}=require('../packages/deep-engine/node_modules/esbuild');
await build({entryPoints:[path.join(root,files[1])],outfile:path.join(out,'probe.mjs'),bundle:true,format:'esm',platform:'browser',conditions:['development'],nodePaths:[path.join(root,'packages/deep-engine/node_modules')]});
const bundleHash=hash(await readFile(path.join(out,'probe.mjs'))),baselinePath=path.join(root,'test-output/interrupted-0930/c8-direct-material-chain/rounds.json');
const baselineBytes=await readFile(baselinePath),baseline=JSON.parse(baselineBytes)[0].find(c=>c.view==='near'&&c.attachment==='raw').run;
const server=createServer(async(req,res)=>{res.setHeader('Content-Type',req.url==='/probe.mjs'?'text/javascript':'text/html');res.end(req.url==='/probe.mjs'?await readFile(path.join(out,'probe.mjs')):'<!doctype html><title>C8 exact F32 inputs</title>');});
let browser;
try{
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const {chromium}=require('../apps/cloud-render-worker/node_modules/playwright-core');
 browser=await chromium.launch({headless:true,executablePath:process.env.BIM_STUDIO_CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const rounds=[],errors=[],samples=[],preservation=[];
 for(let round=0;round<2;round++){
  const captures=[];
  for(const mode of modes){
   const page=await browser.newPage();page.on('pageerror',error=>errors.push(String(error)));let capture;
   try{await page.goto(`http://127.0.0.1:${server.address().port}`);capture={mode,...await page.evaluate(async mode=>(await import('/probe.mjs')).runF32Inputs(mode),mode)};}finally{await page.close();}
   assert.equal(capture.receipt.mode,mode);assert.equal(capture.receipt.qualityCertified,false);assert.equal(capture.receipt.derivative,'default');
   assert.equal(capture.receipt.attachmentBytesPerSample,24);assert.equal(capture.receipt.witnessFormat,'rgba32float');assert.equal(capture.receipt.originalColorFormat,'rgba16float');
   assert.equal(capture.receipt.replacedModules,capture.receipt.moduleCount);assert.notEqual(capture.receipt.instrumentedHash,capture.receipt.baselineInstrumentedHash);
   assert.equal(capture.receipt.passCount,5);assert.equal(capture.receipt.submitted,5);assert.equal(capture.receipt.hookCount,4);assert.equal(capture.validationWitness.length,1);
   assert.deepEqual(capture.run.errors,[]);assert.equal(capture.witness.length,4);captures.push(capture);
   for(const[i,frame]of capture.run.frames.entries()){
    const old=baseline.frames.find(f=>f.name===frame.name);assert(old);assert.equal(frame.rootHash,old.rootHash);assert.equal(frame.packetHash,old.packetHash);assert.equal(frame.profileHash,old.profileHash);
    const witness=capture.witness[i];assert.equal(witness.name,frame.name);assert.equal(witness.format,'rgba32float');assert.equal(witness.bytesPerRow,5120);
    const max=(a,b)=>a.reduce((s,v,k)=>Math.max(s,Math.abs(v-b[k])),0);
    const item={mode,frame:frame.name,deepOriginal16:max(frame.deep.hdr,old.deep.hdr),deepDisplay:max(frame.deep.display,old.deep.display),threeOriginalFull32:max(frame.three.hdr,old.three.hdr),threeDisplay:max(frame.three.display,old.three.display)};
    if(round===0)preservation.push(item);
    for(const key of ['deepOriginal16','deepDisplay','threeOriginalFull32','threeDisplay'])assert.equal(item[key],0,`${mode}/${frame.name} changed original ${key}`);
    if(round===0&&frame.stage==='direct-diagnostic')for(const[x,y]of frame.camera===0?[[62,40]]:[[76,45],[76,46]]){
      const p=y*320+x,rgba=witness.rgba.slice(p*4,p*4+4);assert(rgba.every(Number.isFinite));
      samples.push({mode,frame:frame.name,x,y,lanes:capture.receipt.lanes,basis:capture.receipt.basis,actualInputs32:rgba,deepOriginal16:frame.deep.hdr.slice(p*3,p*3+3),threeOriginalFull32:frame.three.hdr.slice(p*3,p*3+3)});
    }
   }
   if(captures.length>1)assert.deepEqual(capture.run,captures[0].run,'F32 input modes altered original complete output');
  }
  rounds.push(captures);await writeFile(path.join(out,'rounds.json'),JSON.stringify(rounds));
 }
 assert.deepEqual(errors,[]);assert.deepEqual(rounds[0],rounds[1],'two fresh exact F32 input captures drifted');
 for(const f of files)assert.equal(hash(await readFile(path.join(root,f))),sourceIdentity[f],`source changed: ${f}`);
 assert.equal(hash(await readFile(baselinePath)),hash(baselineBytes));
 const evidence={passed:true,qualityCertified:false,stable:true,sourceIdentity,bundleHash,baselineHash:hash(baselineBytes),samples,preservation,
  scope:'Actual Deep pre-store normal/view/rough/default dx/dy/BRDF dots in same-pass F32; original Three full and Deep full16 outputs preserved. No GPU primitive-id or Three F32 inputs observed; no threshold changes.'};
 await writeFile(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}catch(error){const failure=JSON.stringify({passed:false,qualityCertified:false,sourceIdentity,bundleHash,error:String(error)},null,2);await writeFile(path.join(out,`failure-${Date.now()}.json`),failure);await writeFile(path.join(out,'failure.json'),failure);throw error;}
finally{try{await browser?.close()}finally{if(server.listening)await new Promise(resolve=>server.close(resolve))}}
