import assert from "node:assert/strict";
import {copyFile,mkdir,readFile,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import type {SceneSnapshot} from "@bim-studio/contracts";
import {compileNativeSceneCandidate} from "../apps/api/src/nativeSceneCandidateCompiler.js";
import {captureNativePlayerWindow} from "./lib/dashboardNativeWindowCapture.mjs";

const [exeArg,sourceArg,outputArg]=process.argv.slice(2);
assert(exeArg&&sourceArg&&outputArg,"Expected <native.exe> <GI GLB directory> <new evidence directory>");
const output=path.resolve(outputArg);await mkdir(output);
const executable=path.join(output,"verified-player.exe");await copyFile(path.resolve(exeArg),executable);
const sha=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const radius=Math.hypot(3,1.5,3),distance=radius/Math.sin(25*Math.PI/180)*1.05,normal=Math.hypot(6,4,7);
const scene:SceneSnapshot={schemaVersion:1,id:"baked-gi",projectId:"default",name:"Native baked GI",createdAt:"",updatedAt:"",
  models:[{modelId:"room",assetModelId:"room",name:"Baked room",visible:true,opacity:1,transform:{position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}}}],primitives:[],measurements:[],
  camera:{mode:"orbit",position:{x:6*distance/normal,y:1.5+4*distance/normal,z:7*distance/normal},target:{x:0,y:1.5,z:0}},
  environment:{skybox:"none",gridVisible:false,backgroundColor:"#172126"},
  lighting:{enabled:true,intensity:1,shadowsEnabled:false,reflectionsEnabled:false,globalIlluminationEnabled:false,
    lights:[{id:"sun",name:"Sun",type:"directional",enabled:true,color:"#ffffff",intensity:0,position:{x:5,y:5,z:5},target:{x:0,y:0,z:0},castShadow:false},
      {id:"reference",name:"Fixed reference light",type:"point",enabled:true,color:"#ffffff",intensity:2,position:{x:1,y:4,z:3},distance:20,decay:2,castShadow:false}]}};
const evidence=[],pixels:Buffer[][]=[];
for(const [index,kind] of ["off","on"].entries()){
  const source=await readFile(path.resolve(sourceArg,`round-1-gi-${kind}.glb`));
  const compiled=await compileNativeSceneCandidate({scene,models:new Map([["room",source]])});
  const runtime=JSON.parse(compiled.packageJson),packet=runtime.payloads[runtime.entrypoints.renderPacket];
  assert(packet.materials.some((material:Record<string,unknown>)=>material.emissiveTexture),"Baked emissive texture must survive compilation");
  assert(packet.geometries.some((geometry:Record<string,unknown>)=>geometry.uv1),"Baked UV1 must survive compilation");
  const file=path.join(output,`${kind}.runtime.json`);await writeFile(file,compiled.packageJson);
  pixels[index]=[];const captures=[];
  for(const round of [1,2]){
    const capture=await captureNativePlayerWindow({label:`gi-${kind}-${round}`,executable,args:["--package",file],env:undefined,outputDirectory:output,presentedMarker:"native package recovery checkpoint committed after present",timeoutMs:60000});
    const match=/client=(\d+)x(\d+) dpi=\d+ clientOffset=(\d+),(\d+)/.exec(capture.captureLog);assert(match);
    const [width,height,left,top]=match.slice(1).map(Number) as [number,number,number,number];
    const bytes=await sharp(capture.png).extract({left,top,width,height}).ensureAlpha().raw().toBuffer();pixels[index]!.push(bytes);
    captures.push({...capture,clientRgbaSha256:sha(bytes)});
  }
  assert(pixels[index]![0]!.equals(pixels[index]![1]!),"Repeat native GI captures must be stable");
  evidence.push({kind,sourceSha256:sha(source),runtimeSha256:sha(Buffer.from(compiled.packageJson)),materials:packet.materials,captures});
}
assert.equal(pixels[0]![0]!.length,pixels[1]![0]!.length);
let changed=0;for(let i=0;i<pixels[0]![0]!.length;i++)if(pixels[0]![0]![i]!==pixels[1]![0]![i])changed++;
assert(changed>1000,"Indirect bounce must change actual Native pixels under identical fixed direct light and zero IBL");
await writeFile(path.join(output,"evidence.json"),JSON.stringify({evidence,changedChannels:changed,nativeExecutableSha256:sha(await readFile(executable)),lighting:"Identical fixed reference point light, zero IBL; only baked GLB differs"},null,2));
console.log(JSON.stringify({output,changedChannels:changed}));
