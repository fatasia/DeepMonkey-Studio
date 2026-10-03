import {describe,expect,it} from "vitest";
import {createPathTraceRenderPacketKernel} from "./pathTraceRenderPacketKernel.js";
import {RUNTIME_COORDINATE_PROFILE,runtimeLocalToWorld} from "../runtimePackage/coordinates.js";
import type {RuntimeSceneCamera} from "../runtimePackage/camera.js";
const packet={geometries:[{id:"surface",revision:1,indices:new Uint32Array([0,1,2]),
  vertices:new Float32Array([-1e5,-1e5,0,0,0,1,1e5,-1e5,0,0,0,1,0,1e5,0,0,0,1])}],
  materials:[{id:"pbr",baseColor:[.8,.4,.2] as const,metallic:.5,roughness:1,doubleSided:true}],
  instances:[{id:"surface",geometry:"surface",material:"pbr",transform:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}]};
const camera:RuntimeSceneCamera={schema:"deep-engine.scene-camera",schemaVersion:2,id:"camera",revision:1,
  position:[0,0,3],target:[0,0,0],verticalFovDegrees:1,near:.1,far:10,
  coordinateFrame:{schemaVersion:1,profile:RUNTIME_COORDINATE_PROFILE,origin:{x:1e9,y:-2e9,z:3e9}}};
const make=(value:RuntimeSceneCamera)=>createPathTraceRenderPacketKernel({packet,camera:value,width:1,height:1,
  environment:[1,1,1],rouletteStart:64,maxBounces:1});
describe("PT formal camera coordinate frame consumption",()=>{
  it("keeps integration scene-local and exposes a validated immutable world attribution",()=>{
    const input=structuredClone(camera),framed=make(input);
    const {coordinateFrame:_,...bare}=camera,plain=make({...bare,schemaVersion:1});
    expect(runtimeLocalToWorld({x:0,y:0,z:3},framed.coordinateFrame!)).toEqual({x:1e9,y:-2e9,z:3e9+3});
    for(let i=0;i<1024;i++)expect(framed.traceSample(0,0,i,19)).toEqual(plain.traceSample(0,0,i,19));
    (input.coordinateFrame!.origin as {x:number}).x=0;
    expect(framed.coordinateFrame!.origin.x).toBe(1e9);
    expect(Object.isFrozen(framed.coordinateFrame!.origin)).toBe(true);expect(Object.isFrozen(framed.coordinateFrame!.profile)).toBe(true);
  });
  it("rejects unknown frame precision, invalid grid and world roundtrip loss",()=>{
    expect(()=>make({...camera,coordinateFrame:{...camera.coordinateFrame!,profile:{...RUNTIME_COORDINATE_PROFILE,
      maxRoundTripError:1}}} as RuntimeSceneCamera)).toThrow(/profile/);
    expect(()=>make({...camera,coordinateFrame:{...camera.coordinateFrame!,origin:{x:1001,y:0,z:0}}})).toThrow(/origin/);
    expect(()=>make({...camera,position:[.0001,.0001,.0001],coordinateFrame:{...camera.coordinateFrame!,
      origin:{x:1e16,y:1e16,z:1e16}}})).toThrow(/precision/);
  });
});
