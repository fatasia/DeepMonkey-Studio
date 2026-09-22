/** Reuses an already verified publication; never rebuilds its Native candidate. */
import {readFile,writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {pathToFileURL} from "node:url";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import path from "node:path";
import assert from "node:assert/strict";
import {JsonStore} from "../apps/api/src/jsonStore.js";
import {LocalObjectStore} from "../apps/api/src/objects.js";
import {createApiServer} from "../apps/api/src/serverOptions.js";
import {registerSystemRoutes} from "../apps/api/src/system.js";
import {registerSceneRoutes} from "../apps/api/src/sceneRoutes.js";
const directory=path.resolve(process.argv[2]!);assert(process.argv[2],"Expected publication evidence directory");
const root=path.resolve(import.meta.dirname,".."),dataDir=path.join(directory,"data");
const store=new JsonStore(dataDir);await store.init();
const publication=JSON.parse(await readFile(path.join(directory,"publication.json"),"utf8"));
const app=createApiServer();await registerSystemRoutes(app,store,dataDir);await registerSceneRoutes(app,{store,deliveryStorage:{objects:new LocalObjectStore(dataDir),dataDir}});
await app.listen({port:0,host:"127.0.0.1"});const address=app.server.address();assert(address && typeof address!=="string");
const base=`http://127.0.0.1:${address.port}`;let token="";
try {
  const request=async(url:string,body?:unknown)=>{const response=await fetch(base+url,{method:body?"POST":"GET",headers:{"content-type":"application/json",...(token?{authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();assert(response.ok,JSON.stringify(value));return value;};
  token=(await request("/api/auth/login",{username:"admin",password:"admin"})).token;
  const {build}=createRequire(path.join(root,"apps/api/package.json"))("esbuild");
  const exporter=path.join(directory,"frozen-exporter.mjs");
  await build({absWorkingDir:root,entryPoints:["apps/web/src/delivery/sceneClientPackage.ts"],outfile:exporter,bundle:true,platform:"node",format:"esm",conditions:["development"],logLevel:"error",plugins:[{name:"frozen-http",setup(build:any){
    build.onResolve({filter:/^\.\.\/api$/},()=>({path:"api",namespace:"http"}));build.onResolve({filter:/browserDownload$/},()=>({path:"download",namespace:"http"}));build.onResolve({filter:/viewerAssetTransport$/},()=>({path:"viewer",namespace:"http"}));
    build.onLoad({filter:/.*/,namespace:"http"},({path:name}:{path:string})=>({contents:name==="api"?"export const api=globalThis.frozenTransport;":name==="download"?"export const downloadBlob=(blob,name)=>{globalThis.frozenDownload={blob,name}};":"export const loadViewerAssetBuffer=()=>{throw new Error('Unexpected live read')};",loader:"js"}));
  }}]});
  const state=globalThis as any;
  state.frozenTransport={getScenePublicationDependencies:(p:string,s:string,v:number)=>request(`/api/projects/${p}/scenes/${s}/publications/${v}/dependencies`),loadScenePublicationResource:async(url:string,bytes:number,signal:AbortSignal)=>{
    const response=await fetch(base+url,{signal,headers:{authorization:`Bearer ${token}`}});assert(response.ok);const data=await response.arrayBuffer();assert.equal(data.byteLength,bytes);return data;
  }};
  const {exportSceneClientPackage}=await import(pathToFileURL(exporter).href);
  await exportSceneClientPackage({projectId:publication.projectId,scene:publication.snapshot,publication,target:"deep-native",renderer:"webgl",toolbarVisible:true});
  assert(state.frozenDownload?.blob);const zip=path.join(directory,"frozen-native.bimscene.zip");await writeFile(zip,new Uint8Array(await state.frozenDownload.blob.arrayBuffer()));
  const verified=await promisify(execFile)(process.execPath,[path.join(root,"scripts/verify-scene-client-package.mjs"),zip,"--target","deep-native"],{cwd:root,maxBuffer:1024*1024});
  await writeFile(path.join(directory,"archive-verification.json"),verified.stdout);console.log(verified.stdout);
} finally {await app.close();}
