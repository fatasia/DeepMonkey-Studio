import {describe,expect,it,vi} from "vitest";
import {preparePathTraceTriangleNormals,pathTraceTriangleWeights,preparePathTraceWorldNormals,
  interpolatePathTraceWorldNormal,pathTraceWorldNormal} from "./pathTraceTriangleNormals.js";
import {buildPathTraceRenderPacketScene} from "./pathTraceRenderPacketScene.js";
import * as rayTrace from "./rayTrace.js";
import type {GeometryResource,RenderPacket} from "../renderPacketTypes.js";
const geometry=():GeometryResource=>({id:"triangle",revision:1,indices:new Uint32Array([0,1,2]),
  vertices:new Float32Array([0,0,0,0,0,1,2,0,0,.6,0,.8,0,2,0,0,.8,.6])});
const unit=(v:number[])=>{const length=Math.hypot(...v);return v.map(x=>x/length);};
const material={id:"material",baseColor:[.5,.25,.75] as const,metallic:.5,roughness:1,doubleSided:true};
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
describe("PT authored normal Gram interpolation",()=>{
  it.each([false,true])("preserves small authored tilt and varying normals on actual packet hits: %s",varying=>{
    const g=geometry(),corners=[unit([.001,0,1]),unit([varying?.002:.001,0,1]),unit([.001,varying?.001:0,1])];
    corners.forEach((normal,corner)=>g.vertices.set(normal,corner*6+3));
    expect(preparePathTraceTriangleNormals(g)[0]!.flat).toBe(false);
    const scene=buildPathTraceRenderPacketScene({geometries:[g],materials:[material],instances:[
      {id:"small",geometry:"triangle",material:"material",transform:identity}]});
    const hit=scene.traceSurface({ox:.5,oy:.5,oz:3,dx:0,dy:0,dz:-1,tMax:10})!;
    const stored=corners.map((_,corner)=>unit(Array.from(g.vertices.slice(corner*6+3,corner*6+6))));
    const expected=unit([0,1,2].map(axis=>stored[0]![axis]!*.5+stored[1]![axis]!*.25+stored[2]![axis]!*.25));
    expected.forEach((value,axis)=>expect(hit.normal[axis]).toBeCloseTo(value,14));
    expect(hit.normal[0]).toBeGreaterThan(.0009);expect(hit.geometricNormal).toEqual([0,0,1]);
    if(varying)expect(hit.normal[1]).toBeGreaterThan(.0002);
  });
  it.each([[0,0,[1,0,0]],[2,0,[0,1,0]],[0,2,[0,0,1]],[1,0,[.5,.5,0]],[.5,.5,[.5,.25,.25]]])
    ("reconstructs independent analytic weights at %s,%s",(x,y,expected)=>{
      const triangle=preparePathTraceTriangleNormals(geometry())[0]!;
      expect(pathTraceTriangleWeights(triangle,[x as number,y as number,0])).toEqual(expected);
    });
  it("normalizes transformed corner normals before interpolation like production vertices",()=>{
    const triangle=preparePathTraceTriangleNormals(geometry())[0]!,inverse=[.5,0,0,0,0,1/3,0,0,0,0,.25,0];
    const world=preparePathTraceWorldNormals(triangle,inverse),weights=[.5,.25,.25] as const;
    const b=unit([.6/2,0,.8/4]),c=unit([0,.8/3,.6/4]);
    const expected=unit([.25*b[0]!, .25*c[1]!, .5+.25*b[2]!+.25*c[2]!]);
    const actual=interpolatePathTraceWorldNormal(world.corners,weights);
    for(let i=0;i<3;i++)expect(actual[i]).toBeCloseTo(expected[i]!,7);
    const wrong=pathTraceWorldNormal([.15,.2,.85],inverse);
    expect(Math.hypot(...actual.map((x,i)=>x-wrong[i]!))).toBeGreaterThan(.06);
  });
  it.each([[[-1,0,0,0,0,2,0,0,0,0,3,0,4,5,6,1]],
    [[0,2,0,0,-3,0,0,0,0,0,4,0,4,5,6,1]],
    [[2,0,0,0,.5,3,0,0,0,0,4,0,4,5,6,1]]])
    ("consumes actual mirrored/rotated/sheared shared instances",transform=>{
      const packet:RenderPacket={geometries:[geometry()],materials:[material],instances:[
        {id:"transformed",geometry:"triangle",material:"material",transform},
        {id:"far",geometry:"triangle",material:"material",transform:[...identity.slice(0,12),100,100,100,1]}]};
      const scene=buildPathTraceRenderPacketScene(packet);
      const x=transform[0]!* .5+transform[4]!* .5+transform[12]!,
        y=transform[1]!* .5+transform[5]!* .5+transform[13]!,z=transform[14]!;
      const hit=scene.traceSurface({ox:x,oy:y,oz:z+3,dx:0,dy:0,dz:-1,tMax:10})!;
      expect(hit.t).toBeCloseTo(3,12);
      for(let i=0;i<3;i++)expect(hit.geometricNormal![i]).toBeCloseTo([0,0,1][i]!,14);
      expect(hit.normal.every(Number.isFinite)).toBe(true);expect(Math.hypot(...hit.normal)).toBeCloseTo(1,13);
      expect(scene.uniqueBlasCount).toBe(1);expect(scene.instanceCount).toBe(2);
      packet.geometries[0]!.vertices.fill(99);
      expect(scene.traceSurface({ox:x,oy:y,oz:z+3,dx:0,dy:0,dz:-1,tMax:10})).toEqual(hit);
    });
  it("rejects non-unit/reversed normals and unsupported interpolation precision",()=>{
    for(const normal of [[0,0,0],[0,0,-1],[0,0,2]]){
      const g=geometry();g.vertices.set(normal,3);expect(()=>preparePathTraceTriangleNormals(g)).toThrow(/normal/);
    }
    const triangle=preparePathTraceTriangleNormals(geometry())[0]!;
    expect(()=>pathTraceTriangleWeights(triangle,[4,4,0])).toThrow(/precision/);
    expect(()=>preparePathTraceWorldNormals(triangle,[1,0,0,0,0,1,0,0,-.5,0,.1,0])).toThrow(/hemisphere/);
  });
  it("constructs one actual BLAS for shared instances and reuses it on every smooth ray",()=>{
    const build=vi.spyOn(rayTrace,"buildTracedScene");
    try{
      const scene=buildPathTraceRenderPacketScene({geometries:[geometry()],materials:[material],instances:[
        {id:"a",geometry:"triangle",material:"material",transform:identity},
        {id:"b",geometry:"triangle",material:"material",transform:[...identity.slice(0,12),4,0,0,1]}]});
      expect(build).toHaveBeenCalledTimes(1);
      for(let i=0;i<4096;i++)expect(scene.traceSurface({ox:i%2?4.5:.5,oy:.5,oz:3,dx:0,dy:0,dz:-1,tMax:10})).toBeDefined();
      expect(build).toHaveBeenCalledTimes(1);
    }finally{build.mockRestore();}
  });
});
