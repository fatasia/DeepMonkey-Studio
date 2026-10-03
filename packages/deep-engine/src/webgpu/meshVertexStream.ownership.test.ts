import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import type {DeviceSession} from "./deviceSession.js";
import type {GeometryResource} from "../renderPacketTypes.js";
import {MeshBuffers} from "./meshBuffers.js";
const geometry=():GeometryResource=>({id:"mutable",revision:0,
  vertices:new Float32Array([0,0,0,0,0,1, 1,0,0,0,0,1, 0,1,0,0,0,1]),indices:new Uint32Array([0,1,2]),uv0:new Float32Array([0,0,1,0,0,1])});
function setup(source:GeometryResource,admitted=true){
  const owned=new Set<GPUBuffer>(),contents=new Map<GPUBuffer,number[]>();
  const device={limits:{maxBufferSize:1<<20},createBuffer:vi.fn(()=>({destroy:vi.fn()} as unknown as GPUBuffer)),
    queue:{writeBuffer:vi.fn((b:GPUBuffer,_offset:number,data:Float32Array|Uint32Array)=>contents.set(b,Array.from(data)))}};
  const session={state:"ready",device,own(b:GPUBuffer){owned.add(b);return b;},release(b:GPUBuffer){if(owned.delete(b))b.destroy();}};
  const mesh=new MeshBuffers(session as unknown as DeviceSession,source,undefined,admitted?{vertexStreaming:true}:undefined);
  return {mesh,contents,device,owned};
}
beforeEach(()=>vi.stubGlobal("GPUBufferUsage",{VERTEX:32,INDEX:16,COPY_DST:8}));
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe("constructor upload baseline remains authoritative",()=>{
  it("constructor -> mutate caller vertices -> first stage still uploads the actual changed bytes",()=>{
    const source=geometry(),f=setup(source),front=f.mesh.vertices;source.vertices[0]=.25;
    const writes=f.device.queue.writeBuffer.mock.calls.length,lease=f.mesh.stageVertexUpdate({...source,revision:1});
    expect(f.device.queue.writeBuffer.mock.calls.length).toBe(writes+1);expect(f.contents.get(front)![0]).toBe(0);
    lease.commit();expect(f.contents.get(f.mesh.vertices)![0]).toBe(.25);f.mesh.dispose();expect(f.owned.size).toBe(0);
  });
  it("constructor -> mutate caller indices -> first stage rejects topology drift",()=>{
    const source=geometry(),f=setup(source),writes=f.device.queue.writeBuffer.mock.calls.length;
    source.indices[1]=2;source.indices[2]=1;
    expect(()=>f.mesh.stageVertexUpdate({...source,revision:1})).toThrow(/topology/);
    expect(f.device.queue.writeBuffer.mock.calls.length).toBe(writes);f.mesh.dispose();
  });
  it("constructor -> mutate caller UV -> first stage rejects UV drift",()=>{
    const source=geometry(),f=setup(source);source.uv0![0]=.5;
    expect(()=>f.mesh.stageVertexUpdate({...source,revision:1})).toThrow(/UV/);f.mesh.dispose();
  });
  it("default meshes neither snapshot author arrays nor allow delayed admission",()=>{
    const source=geometry(),copyVertices=vi.spyOn(source.vertices,"slice"),copyIndices=vi.spyOn(source.indices,"slice"),f=setup(source,false);
    expect(copyVertices).not.toHaveBeenCalled();expect(copyIndices).not.toHaveBeenCalled();
    source.vertices[0]=.25;expect(()=>f.mesh.stageVertexUpdate({...source,revision:1})).toThrow(/constructor opt-in/);
    expect(f.owned.size).toBe(2);f.mesh.dispose();
  });
  it("mutating returned lease geometry cannot replace the hidden uploaded baseline",()=>{
    const source=geometry(),f=setup(source);source.vertices[0]=.25;
    const first=f.mesh.stageVertexUpdate({...source,revision:1});first.commit();first.geometry.vertices[0]=.75;source.vertices[0]=.75;
    const writes=f.device.queue.writeBuffer.mock.calls.length,second=f.mesh.stageVertexUpdate({...source,revision:2});
    expect(f.device.queue.writeBuffer.mock.calls.length).toBe(writes+1);second.commit();
    expect(f.contents.get(f.mesh.vertices)![0]).toBe(.75);f.mesh.dispose();expect(f.owned.size).toBe(0);
  });
});
