import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import type {GeometryResource,RenderPacket} from "../renderPacket.js";
import type {DeviceSession} from "./deviceSession.js";
import {PacketBuffers} from "./packetBuffers.js";
import {makeSession,makePacket,bindings} from "./vertexStream.testUtils.js";
import {projectSoftBodyRenderPacket} from "../physics/softBodyRenderProjection.js";
import {createPacketGeometryBounds} from "./packetGeometryBounds.js";

function deviceFixture(id:string|undefined="g"){
  const owned=new Set<GPUBuffer>(),allocated:GPUBuffer[]=[],contents=new Map<GPUBuffer,number[]>();
  const device={limits:{maxBufferSize:256*1024*1024},createBuffer:vi.fn((d:GPUBufferDescriptor)=>{
    const b={label:d.label,destroy:vi.fn()} as unknown as GPUBuffer;allocated.push(b);return b;}),
    createShaderModule:vi.fn(()=>({})),createBindGroupLayout:vi.fn(()=>({})),createPipelineLayout:vi.fn(()=>({})),
    createComputePipeline:vi.fn(()=>({})),createBindGroup:vi.fn(()=>({})),
    pushErrorScope:vi.fn(),popErrorScope:vi.fn(()=>Promise.resolve(null as GPUError|null)),
    queue:{writeBuffer:vi.fn((b:GPUBuffer,_o:number,a:Float32Array|Uint32Array)=>contents.set(b,Array.from(a)))}};
  const session={state:"ready",device,assertResourceAdmission:vi.fn(),own(b:GPUBuffer){owned.add(b);return b;},release(b:GPUBuffer){if(owned.delete(b))b.destroy();}};
  const cache=new PacketBuffers(session as unknown as DeviceSession,undefined,undefined,false,false,undefined,id);
  return {owned,allocated,contents,device,session,cache};
}
const source=():GeometryResource=>({id:"g",revision:0,vertices:new Float32Array([0,0,0,0,0,1, 1,0,0,0,0,1, 0,1,0,0,0,1]),indices:new Uint32Array([0,1,2])});
const packet=(g=source()):RenderPacket=>({geometries:[g],materials:[{id:"m",baseColor:[.5,.5,.5],metallic:0,roughness:.5}],
  instances:[{id:"i",geometry:"g",material:"m",transform:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}]});
const moved=(p:RenderPacket):RenderPacket=>{const g=p.geometries[0]!,vertices=g.vertices.slice();vertices[0]=vertices[0]!+.1;return {...p,geometries:[{...g,revision:g.revision+1,vertices}]};};
const empty:RenderPacket={geometries:[],materials:[],instances:[]};
beforeEach(()=>{vi.stubGlobal("GPUBufferUsage",{VERTEX:32,INDEX:16,COPY_DST:8,STORAGE:128,COPY_SRC:4,INDIRECT:256});vi.stubGlobal("GPUShaderStage",{COMPUTE:4});});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

describe("F6 actual PacketBuffers set publication with single vertex-stream opt-in",()=>{
  it("real solver→projection→set publishes source/bounds/batches/revision; mesh and indices remain owned",()=>{
    const sim=makeSession(),f=deviceFixture("cloth");
    let p=makePacket(sim.readout("cloth")!);
    f.cache.set(p);const original=f.cache.visibilityInputs(),mesh=original.geometries.get("cloth")!.mesh;
    const index=mesh.indices,instanceBuffers=[...original.batches.values()].map(b=>b.buffer),initial=f.allocated.length;
    for(let tick=0;tick<20;tick++){
      sim.step();p=projectSoftBodyRenderPacket(sim,p,bindings);expect(f.cache.set(p)).toBe(true);
      const live=f.cache.visibilityInputs(),g=live.geometries.get("cloth")!;
      expect(g.mesh).toBe(mesh);expect(g.source.revision).toBe(tick+1);expect(g.mesh.indices).toBe(index);
      expect(g.source.vertices).toEqual(p.geometries[0]!.vertices);expect(g.source.vertices).not.toBe(p.geometries[0]!.vertices);
      const bounds=createPacketGeometryBounds(new Map([["cloth",g.source]])).get("cloth")!;
      expect(g.center).toEqual(bounds.center);expect(g.radius).toBe(bounds.radius);
      expect([...live.batches.values()].map(b=>b.buffer)).toEqual(instanceBuffers);
      expect(f.cache.visibilityRevision).toBe(tick+2);expect(index.destroy).not.toHaveBeenCalled();
      const actual=f.contents.get(mesh.vertices)!;for(let v=0;v<72;v++)for(let a=0;a<6;a++)expect(actual[v*10+a]).toBe(g.source.vertices[v*6+a]);
    }
    expect(f.allocated).toHaveLength(initial+1);
    const writes=f.device.queue.writeBuffer.mock.calls.length,rev=f.cache.visibilityRevision;
    expect(f.cache.set(p)).toBe(false);expect(f.cache.visibilityRevision).toBe(rev);expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(writes);
    f.cache.dispose();expect(f.owned.size).toBe(0);for(const b of f.allocated)expect(b.destroy).toHaveBeenCalledOnce();
  });
  it("sync write failure, GPU validation rejection and superseded stage leave the published front retryable",async()=>{
    const f=deviceFixture(),p=packet();f.cache.set(p);const old=f.cache.visibilityInputs().geometries.get("g")!,front=old.mesh.vertices,rev=f.cache.visibilityRevision;
    const next=moved(p);f.device.queue.writeBuffer.mockImplementationOnce(()=>{throw Error("upload");});
    expect(()=>f.cache.set(next)).toThrow(/upload/);expect(f.cache.visibilityInputs().geometries.get("g")).toBe(old);expect(old.mesh.vertices).toBe(front);
    f.device.popErrorScope.mockResolvedValueOnce({message:"validation test"} as GPUError);
    await expect(f.cache.setValidated(next)).rejects.toThrow(/validation test/);expect(old.mesh.vertices).toBe(front);expect(f.cache.visibilityRevision).toBe(rev);
    let finish!:(v:GPUError|null)=>void;
    f.device.popErrorScope.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const pending=f.cache.setValidated(next);const rejected=expect(pending).rejects.toMatchObject({name:"AbortError"});
    expect(f.cache.set(next)).toBe(true);finish(null);await rejected;
    expect(f.cache.visibilityInputs().geometries.get("g")!.mesh).toBe(old.mesh);expect(f.cache.visibilityRevision).toBe(rev+1);
    f.cache.dispose();expect(f.owned.size).toBe(0);
  });
  it("constructor source mutation is compared against owned upload baseline and clear/recreate retires exactly once",()=>{
    const f=deviceFixture();
    for(let cycle=0;cycle<20;cycle++){
      let p=packet();f.cache.set(p);const live=f.cache.visibilityInputs().geometries.get("g")!;
      p.geometries[0]!.vertices[0]=.25;
      p={...p,geometries:[{...p.geometries[0]!,revision:1}]};expect(f.cache.set(p)).toBe(true);
      expect(f.contents.get(live.mesh.vertices)![0]).toBe(.25);expect(live.mesh.indices.destroy).not.toHaveBeenCalled();
      expect(f.owned.size).toBe(5);f.cache.set(empty);expect(f.owned.size).toBe(0);
    }
    f.cache.dispose();for(const b of f.allocated)expect(b.destroy).toHaveBeenCalledOnce();
    const normal=deviceFixture(""),p=packet();
    // Omit the last constructor argument to exercise the exact default path.
    normal.cache.dispose();normal.cache=new PacketBuffers(normal.session as unknown as DeviceSession);
    normal.cache.set(p);const first=normal.cache.visibilityInputs().geometries.get("g")!.mesh;
    normal.cache.set(moved(p));expect(normal.cache.visibilityInputs().geometries.get("g")!.mesh).not.toBe(first);expect(first.indices.destroy).toHaveBeenCalledOnce();normal.cache.dispose();
  });
  it("rejects unsupported membership/material/transform/topology before writes, retaining live ownership",()=>{
    const f=deviceFixture(),p=packet();f.cache.set(p);const front=f.cache.visibilityInputs().geometries.get("g")!.mesh.vertices,writes=f.device.queue.writeBuffer.mock.calls.length;
    const next=moved(p),i=p.instances[0]!;
    const candidates=[{...next,materials:[{...p.materials[0]!,roughness:.9}]},
      {...next,instances:[{...i,transform:[1,0,0,0,0,1,0,0,0,0,1,0,1,0,0,1]}]},
      {...next,instances:[i,{...i,id:"other"}]},
      {...next,geometries:[...next.geometries,{...source(),id:"other"}]},
      {...next,geometries:[{...next.geometries[0]!,indices:new Uint32Array([0,2,1])}]}];
    for(const candidate of candidates)expect(()=>f.cache.set(candidate)).toThrow();
    expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(writes);expect(f.cache.visibilityInputs().geometries.get("g")!.mesh.vertices).toBe(front);
    expect(f.cache.set(next)).toBe(true);f.cache.dispose();expect(f.owned.size).toBe(0);
    const invalid=deviceFixture("missing");expect(()=>invalid.cache.set(p)).toThrow(/requires/);expect(invalid.allocated).toHaveLength(0);invalid.cache.dispose();
  });
  it("packed batch ownership rejects caller transform/material in-place mutation before any vertex upload",()=>{
    const f=deviceFixture(),p=packet();f.cache.set(p);const before=f.cache.visibilityInputs(),batch=[...before.batches.values()][0]!,packed=batch.source.data.slice();
    const next=moved(p),writes=f.device.queue.writeBuffer.mock.calls.length;
    (p.instances[0]!.transform as number[])[12]=2;
    expect(batch.source.data).toEqual(packed);expect(()=>f.cache.set(next)).toThrow(/fixed instances/);
    (p.instances[0]!.transform as number[])[12]=0;
    (p.materials[0]!.baseColor as unknown as number[])[0]=.9;
    expect(batch.source.data).toEqual(packed);expect(()=>f.cache.set(next)).toThrow(/fixed instances/);
    expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(writes);expect(f.cache.visibilityInputs().geometries).toBe(before.geometries);f.cache.dispose();
  });
});
