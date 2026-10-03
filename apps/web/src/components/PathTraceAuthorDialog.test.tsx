import { isValidElement, type ReactNode, type ReactElement, type ComponentProps } from "react";
import {beforeEach,describe,expect,it,vi} from "vitest";
import type {SceneSnapshot} from "@bim-studio/contracts";
import {decodeRadianceHdr} from "@bim-studio/deep-engine/textures";
const harness=vi.hoisted(()=>({cursor:0,cells:[] as unknown[]}));
vi.mock("react",async original=>({...await original<typeof import("react")>(),
  useRef:(value:unknown)=>harness.cells[harness.cursor++]??={current:value},
  useState:(value:unknown)=>{const index=harness.cursor++;if(!(index in harness.cells))harness.cells[index]=value;
    return [harness.cells[index],(next:unknown)=>{harness.cells[index]=next;}];},useEffect:()=>undefined}));
vi.mock("react-dom",()=>({createPortal:(element:unknown)=>element}));
vi.mock("../browserDownload",()=>({downloadBlob:vi.fn(),downloadTextFile:vi.fn()}));
vi.mock("../delivery/browserImageDecoder",()=>({browserImageDecoder:{decode:vi.fn()}}));
vi.mock("../viewer/studioWasmRuntimePackage",()=>({normalizeStudioWasmModel:async(bytes:Uint8Array)=>bytes}));
import {PathTraceAuthorDialog} from "./PathTraceAuthorDialog";
import {PathTraceResolutionPicker} from "./PathTraceResolutionPicker";
import {PathTraceStatusBar} from "./PathTraceStatusBar";
import {PathTraceAuthorBandHost} from "../delivery/pathTraceAuthorBandHost";
import {pathTraceAuthorPreview} from "../delivery/pathTraceAuthorPreview";
import type {PathTraceAuthorWorkerInput,PathTraceAuthorWorkerOutput,PathTraceBandWorker} from "../delivery/pathTraceAuthorWorkerTypes";
import {DEFAULT_ENVIRONMENT,DEFAULT_LIGHTING} from "../appDefaults";
import {downloadBlob,downloadTextFile} from "../browserDownload";
type Element=ReactElement<Record<string,unknown>>;
function nodes(node:ReactNode):Element[]{if(Array.isArray(node))return node.flatMap(nodes);
  if(!isValidElement<Record<string,unknown>>(node))return [];return [node,...nodes(node.props.children as ReactNode)];}
function text(node:ReactNode):string{if(Array.isArray(node))return node.map(text).join("");
  if(typeof node==="string"||typeof node==="number")return String(node);
  return isValidElement<Record<string,unknown>>(node)?text(node.props.children as ReactNode):"";}
class FakeWorker implements PathTraceBandWorker{
  static all:FakeWorker[]=[];onmessage:PathTraceBandWorker["onmessage"]=null;onerror:PathTraceBandWorker["onerror"]=null;
  terminated=false;private readonly host=new PathTraceAuthorBandHost();constructor(){FakeWorker.all.push(this);}
  postMessage(command:PathTraceAuthorWorkerInput){const copy=command.kind==="init"?structuredClone(command):command;
    setImmediate(()=>{if(this.terminated)return;const out=this.host.handle(copy);if(out)this.onmessage?.({data:out as PathTraceAuthorWorkerOutput});});}
  terminate(){this.terminated=true;this.host.handle({kind:"dispose"});}
}
/** Canvas stand-in: a structurally valid PNG whose IDAT payload is the raw RGBA, so the test can read the pixels back. */
class FakeImageData{constructor(readonly data:Uint8ClampedArray,readonly width:number,readonly height:number){}}
class FakeCanvas{last?:FakeImageData;constructor(readonly width:number,readonly height:number){}
  getContext(){return {putImageData:(image:FakeImageData)=>{this.last=image;}};}
  convertToBlob(){const idat=this.last!.data,bytes=new Uint8Array(33+12+idat.length+12),view=new DataView(bytes.buffer);
    bytes.set([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);view.setUint32(8,13);bytes.set([0x49,0x48,0x44,0x52],12);
    view.setUint32(16,this.width);view.setUint32(20,this.height);view.setUint32(33,idat.length);bytes.set([0x49,0x44,0x41,0x54],37);
    bytes.set(idat,41);bytes.set([0x49,0x45,0x4e,0x44],41+idat.length+8);return Promise.resolve(new Blob([bytes]));}}
function scene():SceneSnapshot{return {schemaVersion:1,id:"s",projectId:"p",name:"Authored HDR",models:[],measurements:[],createdAt:"",updatedAt:"",
  primitives:[{modelId:"sphere",kind:"sphere",name:"sphere",visible:true,opacity:1,color:"#b09060",
    transform:{position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}},material:{doubleSided:true,roughness:1,metalness:.5}}],
  camera:{mode:"orbit",position:{x:0,y:0,z:3},target:{x:0,y:0,z:0}},environment:structuredClone(DEFAULT_ENVIRONMENT),lighting:structuredClone(DEFAULT_LIGHTING),weather:"sunny"};}
function app(){let source=scene();const props:ComponentProps<typeof PathTraceAuthorDialog>={locale:"en-US",models:[],sourceKey:"p/s/1",getSnapshot:()=>source,onClose:vi.fn()};
  let tree:Element[]=[];const render=()=>{harness.cursor=0;tree=nodes(PathTraceAuthorDialog(props));};
  const button=(label:string)=>{const item=tree.find(node=>node.type==="button"&&text(node.props.children as ReactNode)===label);if(!item)throw new Error(label);return item;};
  const click=(label:string)=>{const item=button(label);if(!item.props.disabled)(item.props.onClick as()=>void)();};
  const child=<T extends(...args:never[])=>unknown>(type:T)=>tree.find(node=>(node.type as unknown)===type)!.props as Parameters<T>[0];
  const status=()=>child(PathTraceStatusBar).status as string;
  const waitFor=async(condition:()=>boolean,ms=30000)=>{const end=Date.now()+ms;for(;;){render();if(condition())return;
    if(Date.now()>end)throw new Error("timeout: "+status()+" "+tree.filter(node=>node.props.role==="alert").map(node=>text(node.props.children as ReactNode)).join());await new Promise(resolve=>setTimeout(resolve,15));}};
  render();return {props,render,button,click,nodes:()=>tree,child,status,waitFor,source:()=>source,replace:(value:SceneSnapshot)=>{source=value;}};}
const picker=(view:ReturnType<typeof app>)=>view.child(PathTraceResolutionPicker);
beforeEach(()=>{harness.cells=[];harness.cursor=0;FakeWorker.all=[];vi.clearAllMocks();
  vi.stubGlobal("Worker",FakeWorker);vi.stubGlobal("OffscreenCanvas",FakeCanvas);vi.stubGlobal("ImageData",FakeImageData);
  vi.stubGlobal("navigator",{hardwareConcurrency:4,deviceMemory:8});vi.stubGlobal("document",{querySelector:()=>null,body:{}});});
async function renderPreview(view:ReturnType<typeof app>){view.render();picker(view).onChange(160);view.render();
  view.click("Start accumulation");await view.waitFor(()=>!!(view.child(PathTraceStatusBar).progress));
  view.click("Stop and keep");await view.waitFor(()=>view.status().startsWith("Noise gate not met"));}
describe("author render dialog drives the real compiler, N-thread coordinator and band host",{timeout:90000},()=>{
  it("offers 160–1920 tiers, leaves a thread for the UI and keeps exports disabled with reasons before any render",()=>{
    const view=app();view.render();const props=picker(view);expect(props.tiers).toHaveLength(5);
    expect(props.tiers.every(tier=>tier.available&&tier.workers===3)).toBe(true);
    expect(view.nodes().some(node=>text(node.props.children as ReactNode).includes("Realtime GI enhancement is excluded"))).toBe(true);
    for(const label of ["Export HDR","Export PNG","Save preview"]){expect(view.button(label).props.disabled).toBeTruthy();expect(String(view.button(label).props.title)).not.toBe("");}
  });
  it("renders in parallel, merges progress, saves an HDR preview and a matching sRGB PNG with sha256 receipts",async()=>{
    const view=app();await renderPreview(view);
    expect(FakeWorker.all).toHaveLength(3);const bar=view.child(PathTraceStatusBar);expect(bar.workers).toBe(3);
    expect(view.button("Export HDR").props.disabled).toBe(true);
    view.click("Save preview");await view.waitFor(()=>vi.mocked(downloadTextFile).mock.calls.length===1);
    const hdrName=vi.mocked(downloadBlob).mock.calls[0]![1],hdrReceipt=JSON.parse(vi.mocked(downloadTextFile).mock.calls[0]![0]);
    expect(hdrName).toContain("physical-scene-radiance-preview.hdr");expect(hdrReceipt).toMatchObject({preview:true,eligibleFinal:false,parallel:{workers:3,seed:19}});
    expect(hdrReceipt.hdrSha256).toMatch(/^[a-f0-9]{64}$/);
    view.render();view.click("Export PNG");await view.waitFor(()=>vi.mocked(downloadTextFile).mock.calls.length===2);
    const pngName=vi.mocked(downloadBlob).mock.calls[1]![1],pngReceipt=JSON.parse(vi.mocked(downloadTextFile).mock.calls[1]![0]);
    expect(pngName).toMatch(/-preview\.png$/);expect(pngReceipt).toMatchObject({format:"png-srgb",preview:true,width:160,height:90,outputColorSpace:"srgb",
      toneMapping:{operator:"three-aces-r185"}});expect(pngReceipt.pngSha256).toMatch(/^[a-f0-9]{64}$/);
    const png=new Uint8Array(await (vi.mocked(downloadBlob).mock.calls[1]![0] as Blob).arrayBuffer());
    expect(new TextDecoder().decode(png.subarray(37,41))).toBe("sRGB");expect(png.length).toBe(pngReceipt.pngBytes);
    const idatAt=33+13+4;expect(new TextDecoder().decode(png.subarray(idatAt,idatAt+4))).toBe("IDAT");
    const pixels=png.subarray(idatAt+4,idatAt+4+160*90*4),hdr=decodeRadianceHdr(new Uint8Array(await (vi.mocked(downloadBlob).mock.calls[0]![0] as Blob).arrayBuffer()));
    const expected=pathTraceAuthorPreview(hdr).data;let worst=0;for(let i=0;i<expected.length;i++)worst=Math.max(worst,Math.abs(expected[i]!-pixels[i]!));
    expect(worst).toBeLessThanOrEqual(3);expect(pixels[3]).toBe(255);
  });
  it("cancel stops every worker immediately and releases state; nothing is downloaded",async()=>{
    const view=app();view.render();picker(view).onChange(160);view.render();view.click("Start accumulation");
    await view.waitFor(()=>FakeWorker.all.length===3);view.click("Cancel");
    expect(FakeWorker.all.every(worker=>worker.terminated)).toBe(true);view.render();
    expect(view.status()).toContain("Cancelled · Memory released");expect(view.button("Save preview").props.disabled).toBe(true);
    expect(downloadBlob).not.toHaveBeenCalled();
  });
  it("rejects author scene changes at the next progress/export boundary and terminates all workers",async()=>{
    const view=app();view.render();picker(view).onChange(160);view.render();view.click("Start accumulation");
    await view.waitFor(()=>FakeWorker.all.length===3);view.source().primitives[0]!.material!.roughness=.7;
    await view.waitFor(()=>view.status().includes("Scene changed · Accumulation cleared"));
    expect(FakeWorker.all.every(worker=>worker.terminated)).toBe(true);expect(downloadTextFile).not.toHaveBeenCalled();
  });
  it("renders the memory-budget tooltip and disables a tier that does not fit",()=>{
    const tiers=[1,2,3,4,5].map(index=>({available:index<4,workers:index<4?3:0,estimate:{accumulationBytes:1,mainBytes:1,workerBytes:1,totalBytes:index*400*1024*1024}}));
    const tree=nodes(PathTraceResolutionPicker({locale:"en-US",width:320,disabled:false,samples:4096,tiers,budgetBytes:1536*1024*1024,workers:3,onChange:vi.fn()}));
    const radios=tree.filter(node=>node.props.role==="radio");expect(radios.map(node=>Boolean(node.props.disabled))).toEqual([false,false,false,true,true]);
    const titled=tree.filter(node=>node.type==="span"&&String(node.props.title).includes("exceeds"));expect(titled).toHaveLength(2);
    expect(String(titled[0]!.props.title)).toContain("1600 MiB");
  });
});
