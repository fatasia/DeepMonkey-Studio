import {describe,it,expect,vi,beforeEach,afterEach} from "vitest";
import type {GeometryResource,RenderPacket} from "../renderPacket.js";
import type {DeviceSession} from "./deviceSession.js";
import {PacketBuffers} from "./packetBuffers.js";
import {MeshBuffers} from "./meshBuffers.js";
import {makeSession,makePacket,bindings} from "./vertexStream.testUtils.js";
import {projectSoftBodyRenderPacket} from "../physics/softBodyRenderProjection.js";

function fixture(packet?:RenderPacket){
  const owned=new Set<GPUBuffer>(),allocated:GPUBuffer[]=[],contents=new Map<GPUBuffer,number[]>();
  const device={limits:{maxBufferSize:256*1024*1024},createBuffer:vi.fn((d:GPUBufferDescriptor)=>{
    const b={label:d.label,destroy:vi.fn()} as unknown as GPUBuffer;allocated.push(b);return b;}),
    createShaderModule:vi.fn(()=>({})),createBindGroupLayout:vi.fn(()=>({})),createPipelineLayout:vi.fn(()=>({})),
    createComputePipeline:vi.fn(()=>({})),createBindGroup:vi.fn(()=>({})),queue:{writeBuffer:vi.fn((b:GPUBuffer,_o:number,a:Float32Array|Uint32Array)=>contents.set(b,Array.from(a)))}};
  const session={state:"ready",device,assertResourceAdmission:vi.fn(),own(b:GPUBuffer){owned.add(b);return b;},release(b:GPUBuffer){if(owned.delete(b))b.destroy();}};
  const cache=new PacketBuffers(session as unknown as DeviceSession,undefined,undefined,false,false,undefined,packet?.geometries[0]?.id??"g");
  const source:GeometryResource={id:"g",revision:0,vertices:new Float32Array([0,0,0,0,0,1, 1,0,0,0,0,1, 0,1,0,0,0,1]),indices:new Uint32Array([0,1,2]),uv0:new Float32Array([0,0,1,0,0,1])};
  cache.set(packet??{geometries:[source],materials:[{id:"m",baseColor:[.5,.5,.5],metallic:0,roughness:.5}],
    instances:[{id:"i",geometry:"g",material:"m",transform:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}]});
  const cached=cache.visibilityInputs().geometries.values().next().value!;
  const mesh=cached.mesh as unknown as MeshBuffers;
  return {owned,allocated,contents,device,session,cache,mesh,source:cached.source};
}
const moved=(source:GeometryResource,revision=source.revision+1)=>{const vertices=source.vertices.slice();vertices[0]=vertices[0]!+.1;vertices[6]=vertices[6]!+.1;return {...source,revision,vertices};};
beforeEach(()=>{vi.stubGlobal("GPUBufferUsage",{VERTEX:32,INDEX:16,COPY_DST:8,STORAGE:128,COPY_SRC:4,INDIRECT:256});vi.stubGlobal("GPUShaderStage",{COMPUTE:4});});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe("F6 persistent vertices on actual PacketBuffers-owned MeshBuffers",()=>{
  it("writes only the inactive vertex slot; shares indices/UV; returns new revision/bounds",()=>{
    const f=fixture(),front=f.mesh.vertices,index=f.mesh.indices,old=f.contents.get(front),writes=f.device.queue.writeBuffer.mock.calls.length;
    const next=moved(f.source),lease=f.mesh.stageVertexUpdate(next);
    expect(f.mesh.vertices).toBe(front);expect(f.contents.get(front)).toEqual(old);
    expect(f.device.queue.writeBuffer.mock.calls.length).toBe(writes+1);expect(f.allocated).toHaveLength(5);
    expect(lease.bounds.revision).toBe(1);expect(lease.bounds.center).not.toEqual(f.cache.visibilityInputs().geometries.get("g")!.center);
    next.vertices.fill(9);expect(lease.geometry.vertices[0]).toBeCloseTo(.1);
    expect(lease.commit()).toBe(true);expect(f.mesh.vertices).not.toBe(front);expect(f.mesh.indices).toBe(index);
    const actual=f.contents.get(f.mesh.vertices)!;expect(actual[0]).toBeCloseTo(.1);expect(actual.slice(6,10)).toEqual([0,0,0,0]);
    expect(actual.slice(16,20)).toEqual([1,0,0,0]);expect(index.destroy).not.toHaveBeenCalled();
    const pass={setVertexBuffer:vi.fn(),setIndexBuffer:vi.fn(),drawIndexed:vi.fn()};
    f.mesh.draw(pass as unknown as GPURenderPassEncoder,f.cache.visibilityInputs().batches.values().next().value!.buffer,1);
    expect(pass.setVertexBuffer).toHaveBeenCalledWith(0,f.mesh.vertices);expect(pass.setIndexBuffer).toHaveBeenCalledWith(index,"uint32");
    // Resource API intentionally cannot publish the packet's cached visibility owner.
    expect(f.cache.visibilityInputs().geometries.get("g")!.source.revision).toBe(0);
    f.cache.dispose();expect(f.owned.size).toBe(0);for(const b of f.allocated)expect(b.destroy).toHaveBeenCalledOnce();
  });
  it("20 real solver/projection updates reuse exactly two vertex slots and one index buffer",()=>{
    const sim=makeSession();let packet=makePacket(sim.readout("cloth")!);
    const f=fixture(packet),baseline=f.owned.size,index=f.mesh.indices,slots=new Set([f.mesh.vertices]);
    const initialAllocated=f.allocated.length;let current=packet.geometries[0]!;
    for(let i=0;i<20;i++){
      sim.step();packet=projectSoftBodyRenderPacket(sim,packet,bindings);current=packet.geometries[0]!;
      const lease=f.mesh.stageVertexUpdate(current);expect(lease.commit()).toBe(true);slots.add(f.mesh.vertices);
      expect(f.owned.size).toBe(baseline+1);expect(f.mesh.indices).toBe(index);
      const uploaded=f.contents.get(f.mesh.vertices)!;for(let v=0;v<72;v++)for(let a=0;a<6;a++)expect(uploaded[v*10+a]).toBe(current.vertices[v*6+a]);
    }
    expect(slots.size).toBe(2);expect(f.allocated.length).toBe(initialAllocated+1);
    const writes=f.device.queue.writeBuffer.mock.calls.length;const same=f.mesh.stageVertexUpdate(current);expect(same.commit()).toBe(false);
    expect(f.device.queue.writeBuffer.mock.calls.length).toBe(writes);f.cache.dispose();expect(f.owned.size).toBe(0);
  });
  it("discard, failed allocation, failed inactive writes and lost epochs keep the front intact",()=>{
    const f=fixture(),front=f.mesh.vertices,contents=f.contents.get(front);
    f.session.assertResourceAdmission.mockImplementationOnce(()=>{throw Error("budget");});
    expect(()=>f.mesh.stageVertexUpdate(moved(f.source))).toThrow(/budget/);expect(f.owned.size).toBe(4);
    f.device.queue.writeBuffer.mockImplementationOnce(()=>{throw Error("first upload");});
    expect(()=>f.mesh.stageVertexUpdate(moved(f.source))).toThrow(/first upload/);expect(f.owned.size).toBe(4);
    const discarded=f.mesh.stageVertexUpdate(moved(f.source));discarded.discard();expect(()=>discarded.commit()).toThrow(/cancelled/);
    expect(f.mesh.vertices).toBe(front);expect(f.contents.get(front)).toEqual(contents);
    f.device.queue.writeBuffer.mockImplementationOnce(()=>{throw Error("warm upload");});
    expect(()=>f.mesh.stageVertexUpdate(moved(f.source))).toThrow(/warm upload/);expect(f.mesh.vertices).toBe(front);
    const lease=f.mesh.stageVertexUpdate(moved(f.source));f.session.state="lost";expect(()=>lease.commit()).toThrow(/cancelled/);
    lease.discard();expect(f.mesh.vertices).toBe(front);f.session.state="ready";f.mesh.stageVertexUpdate(moved(f.source)).commit();
    f.cache.dispose();expect(f.owned.size).toBe(0);
  });
  it("rejects drift/invalid input before GPU writes and prevents overlapping transactions",()=>{
    const f=fixture(),n=moved(f.source),count=f.device.queue.writeBuffer.mock.calls.length;
    for(const candidate of [{...n,id:"other"},{...n,revision:0},{...n,indices:new Uint32Array([0,2,1])},
      {...n,uv0:new Float32Array([0,0,0,0,0,0])},{...n,tangents:new Float32Array(12)},
      {...n,colors:new Float32Array(12)},{...n,vertices:new Float32Array(12)}])expect(()=>f.mesh.stageVertexUpdate(candidate)).toThrow();
    const bad=n.vertices.slice();bad[0]=NaN;expect(()=>f.mesh.stageVertexUpdate({...n,vertices:bad})).toThrow();
    expect(f.device.queue.writeBuffer.mock.calls.length).toBe(count);
    const lease=f.mesh.stageVertexUpdate(n);expect(()=>f.mesh.stageVertexUpdate(n)).toThrow(/pending/);lease.commit();
    expect(()=>lease.commit()).toThrow(/cancelled/);expect(()=>f.mesh.stageVertexUpdate({...n,revision:0})).toThrow(/monotonic/);
    f.cache.dispose();expect(()=>f.mesh.stageVertexUpdate(n)).toThrow(/live/);
  });
});
