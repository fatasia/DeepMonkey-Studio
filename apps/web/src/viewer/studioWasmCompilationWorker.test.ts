import { afterEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { authorTextureTestGlb } from "../delivery/sceneAuthorTextureTestFixture";
import type { StudioWasmCompilationInput, StudioWasmCompilationOutput } from "./studioWasmCompilationClient";

afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
it("runs the production worker body with credentialed HTTP, worker image decoding and detached transfer",async()=>{
  vi.resetModules();
  const png=await sharp({create:{width:8,height:8,channels:4,background:{r:200,g:100,b:220,alpha:1}}}).png().toBuffer();
  const glb=authorTextureTestGlb(), requests=vi.fn(async(url:string,_options?:RequestInit)=>
    new Response(new Uint8Array(url==="/box.glb"?glb:png)));
  vi.stubGlobal("fetch",requests); vi.stubGlobal("document",undefined);
  const bitmap={width:8,height:8,close:vi.fn()}, pixels=new Uint8ClampedArray(8*8*4);
  for(let offset=0;offset<pixels.length;offset+=4) pixels.set([200,100,220,255],offset);
  const createBitmap=vi.fn(async()=>bitmap), draw=vi.fn();
  vi.stubGlobal("createImageBitmap",createBitmap);
  vi.stubGlobal("OffscreenCanvas",class {getContext(){return {drawImage:draw,getImageData:()=>({data:pixels})};}});
  const received:StudioWasmCompilationOutput[]=[], transfers:ArrayBuffer[][]=[];
  const scope:{onmessage:((event:{data:StudioWasmCompilationInput})=>Promise<void>)|null;
    postMessage:(message:StudioWasmCompilationOutput,transfer?:ArrayBuffer[])=>void}={onmessage:null,
    postMessage(message,transfer=[]){transfers.push(transfer);received.push(structuredClone(message,{transfer}));}};
  vi.stubGlobal("self",scope);
  await import("./studioWasmCompilationWorker");
  const input:StudioWasmCompilationInput={irradianceProbes:null,
    scene:{schemaVersion:1,id:"worker",projectId:"p",name:"Textured",primitives:[],measurements:[],
      models:[{modelId:"i",assetModelId:"box",name:"Box",visible:true,opacity:1,
        material:{baseColorMapUrl:"/base.png"},
        transform:{position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}}}],
      camera:{mode:"orbit",position:{x:0,y:2,z:5},target:{x:0,y:0,z:0}},createdAt:"",updatedAt:""},
    models:[{id:"box",name:"Box",status:"ready",manifest:{geometryUrl:"/box.glb"} as NonNullable<StudioWasmCompilationInput["models"][number]["manifest"]>}]};
  await scope.onmessage!({data:input});
  const response=received.find(output=>"bytes" in output);
  expect(response).toBeDefined();
  if(!response||!("bytes" in response)) throw new Error(JSON.stringify(received));
  expect(new TextDecoder().decode(response.bytes.subarray(0,8))).toBe("DMPBIN1\n");
  const length=new DataView(response.bytes.buffer).getUint32(8,true);
  const header=JSON.parse(new TextDecoder().decode(response.bytes.subarray(12,12+length)));
  const plane=header.sections.find((value:{path:string})=>value.path==="/textures/0/data");
  expect([...response.bytes.subarray(12+length+plane.offset,12+length+plane.offset+4)]).toEqual([200,100,220,255]);
  expect(response.canonicalHash).toMatch(/^[0-9a-f]{64}$/);
  expect(createBitmap).toHaveBeenCalledOnce(); expect(draw).toHaveBeenCalledOnce(); expect(bitmap.close).toHaveBeenCalledOnce();
  expect(requests.mock.calls.map(([url])=>url)).toEqual(["/box.glb","/base.png"]);
  for(const call of requests.mock.calls) expect(call[1]).toMatchObject({credentials:"same-origin",signal:expect.any(AbortSignal)});
  expect(received.filter(output=>"kind" in output).map(output=>"stage" in output?output.stage:"invalid"))
    .toEqual(expect.arrayContaining(["starting","assets","geometry","textures","package","complete"]));
  expect(transfers.at(-1)).toHaveLength(1); expect(transfers.at(-1)![0]!.byteLength).toBe(0);
}, 20_000);
