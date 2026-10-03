import { isValidElement, type ReactNode, type ReactElement, type ComponentProps } from "react";
import {beforeEach,describe,expect,it,vi} from "vitest";
import type {SceneSnapshot} from "@bim-studio/contracts";
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
import {PathTraceAuthorSession} from "../delivery/pathTraceAuthorSession";
import {pathTraceAuthorPreview} from "../delivery/pathTraceAuthorPreview";
import type {PathTraceAuthorWorkerInput,PathTraceAuthorWorkerOutput} from "../delivery/pathTraceAuthorWorkerTypes";
import {DEFAULT_ENVIRONMENT,DEFAULT_LIGHTING} from "../appDefaults";
import {downloadBlob,downloadTextFile} from "../browserDownload";
type Element=ReactElement<Record<string,unknown>>;
function nodes(node:ReactNode):Element[]{if(Array.isArray(node))return node.flatMap(nodes);
  if(!isValidElement<Record<string,unknown>>(node))return [];return [node,...nodes(node.props.children as ReactNode)];}
function text(node:ReactNode):string{if(Array.isArray(node))return node.map(text).join("");
  if(typeof node==="string"||typeof node==="number")return String(node);
  return isValidElement<Record<string,unknown>>(node)?text(node.props.children as ReactNode):"";}
class WorkerBoundary {
  static instances:WorkerBoundary[]=[];onmessage?: (event:MessageEvent<PathTraceAuthorWorkerOutput>)=>unknown;
  onerror?:unknown;session?:PathTraceAuthorSession;terminated=false;
  constructor(){WorkerBoundary.instances.push(this);}
  postMessage(command:PathTraceAuthorWorkerInput){
    if(command.kind==="start")this.session=new PathTraceAuthorSession(command.prepared);
    if(command.kind==="export")void this.onmessage?.({data:{kind:"exported",output:this.session!.export(command.preview,command.sourceHash)}} as MessageEvent<PathTraceAuthorWorkerOutput>);
  }
  frame(done=false){this.session!.render.advance(1);const message:PathTraceAuthorWorkerOutput={kind:"progress",done,
    image:pathTraceAuthorPreview(this.session!.render.image()),samples:this.session!.render.session.sampleCount,noise:this.session!.render.maxRelativeStandardError,
    converged:this.session!.render.converged};void this.onmessage?.({data:message} as MessageEvent<PathTraceAuthorWorkerOutput>);return message;}
  terminate(){this.terminated=true;this.session?.dispose();}
}
function scene():SceneSnapshot{return {schemaVersion:1,id:"s",projectId:"p",name:"Authored HDR",models:[],measurements:[],createdAt:"",updatedAt:"",
  primitives:[{modelId:"sphere",kind:"sphere",name:"sphere",visible:true,opacity:1,color:"#b09060",
    transform:{position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}},material:{doubleSided:true,roughness:1,metalness:.5}}],
  camera:{mode:"orbit",position:{x:0,y:0,z:3},target:{x:0,y:0,z:0}},environment:structuredClone(DEFAULT_ENVIRONMENT),lighting:structuredClone(DEFAULT_LIGHTING),weather:"sunny"};}
async function flush(){for(let i=0;i<40;i++)await Promise.resolve();}
function app(){let source=scene();const props:ComponentProps<typeof PathTraceAuthorDialog>={locale:"en-US",models:[],sourceKey:"p/s/1",getSnapshot:()=>source,onClose:vi.fn()};
  let tree:Element[]=[];const render=()=>{harness.cursor=0;tree=nodes(PathTraceAuthorDialog(props));};
  const button=(label:string)=>{const item=tree.find(node=>node.type==="button"&&text(node.props.children as ReactNode)===label);if(!item)throw new Error(label);return item;};
  const click=(label:string)=>{const item=button(label);if(!item.props.disabled)(item.props.onClick as()=>void)();};
  render();return {props,render,button,click,nodes:()=>tree,source:()=>source,replace:(value:SceneSnapshot)=>{source=value;}};}
beforeEach(()=>{harness.cells=[];harness.cursor=0;WorkerBoundary.instances=[];vi.clearAllMocks();
  vi.stubGlobal("Worker",WorkerBoundary);vi.stubGlobal("document",{querySelector:()=>null,body:{}});});
describe("author HDR dialog consumes the real compiler and session across a worker boundary",()=>{
  it("shows explicit physical/reference modes and keeps final export disabled before convergence",async()=>{
    const view=app();expect(view.nodes().some(node=>text(node.props.children as ReactNode).includes("Realtime GI enhancement is excluded"))).toBe(true);
    expect(view.button("Export HDR").props.disabled).toBe(true);view.click("Start accumulation");await flush();
    const worker=WorkerBoundary.instances[0]!;expect(worker.session).toBeDefined();worker.frame(true);view.render();
    expect(view.button("Export HDR").props.disabled).toBe(true);expect(view.button("Save preview").props.disabled).toBeFalsy();
    worker.terminate();
  });
  it("cancels actual accumulation immediately and ignores a queued old-generation progress message",async()=>{
    const view=app();view.click("Start accumulation");await flush();const worker=WorkerBoundary.instances[0]!,queued=worker.frame();
    view.render();view.click("Cancel");expect(worker.terminated).toBe(true);expect(worker.session!.render.session.residentBytes).toBe(0);
    void worker.onmessage?.({data:queued} as MessageEvent<PathTraceAuthorWorkerOutput>);view.render();
    expect(view.nodes().some(node=>text(node.props.children as ReactNode).includes("Cancelled · Memory released"))).toBe(true);
    expect(view.button("Save preview").props.disabled).toBe(true);expect(downloadBlob).not.toHaveBeenCalled();
  });
  it("rejects actual author material changes at the next progress/export boundary",async()=>{
    const view=app();view.click("Start accumulation");await flush();const worker=WorkerBoundary.instances[0]!;
    view.source().primitives[0]!.material!.roughness=.7;worker.frame(true);view.render();
    expect(worker.terminated).toBe(true);expect(worker.session!.render.session.residentBytes).toBe(0);
    expect(view.nodes().some(node=>text(node.props.children as ReactNode).includes("Scene changed · Accumulation cleared"))).toBe(true);
    expect(downloadTextFile).not.toHaveBeenCalled();
  });
  it("writes genuine noise-failing HDR only with preview file names and a preview receipt",async()=>{
    const view=app();view.click("Start accumulation");await flush();const worker=WorkerBoundary.instances[0]!;worker.frame(true);view.render();
    view.click("Save preview");for(let i=0;i<20;i++)await new Promise(resolve=>setTimeout(resolve,0));view.render();
    expect(downloadBlob).toHaveBeenCalledOnce();const name=vi.mocked(downloadBlob).mock.calls[0]![1];
    expect(name).toContain("physical-scene-radiance-preview.hdr");expect(name).not.toContain("final");
    const receipt=JSON.parse(vi.mocked(downloadTextFile).mock.calls[0]![0]);expect(receipt.preview).toBe(true);expect(receipt.eligibleFinal).toBe(false);
    expect(receipt.hdrSha256).toMatch(/^[a-f0-9]{64}$/);worker.terminate();
  });
});
