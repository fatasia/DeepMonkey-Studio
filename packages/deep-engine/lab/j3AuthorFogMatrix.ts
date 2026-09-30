import { buildJ3NormalShadowMatrix, type J3NormalShadowManifest } from "./j3NormalShadowMatrix.js";
import type { DeepRuntimePackageV1 } from "../src/runtimePackage/types.js";
import { materializeRuntimeRenderPacket } from "../src/runtimePackage/renderPacket.js";
import { lookAt } from "../src/webgpu/cameraMath.js";

export interface J3AuthorFogProfile {
  schema:string; color:readonly [number,number,number];
  scenarios:readonly {id:string;density:number;materialFog:boolean}[];
  cpuAbsoluteTolerance:number;crossHostAbsoluteTolerance:number;
}
export function j3AuthorFogRgb(base:readonly number[],depth:number,density:number,color:readonly number[],materialFog:boolean) {
  const t=materialFog?Math.exp(-Math.pow(density*depth,2)):1;
  return base.map((value,i)=>value*t+color[i]!*(1-t));
}
export function buildJ3AuthorFogMatrix(source:DeepRuntimePackageV1,manifest:J3NormalShadowManifest,profile:J3AuthorFogProfile) {
  const matrix=buildJ3NormalShadowMatrix(source,manifest);
  const packet=materializeRuntimeRenderPacket(source.payloads[source.entrypoints.renderPacket],"$.authorFogPacket");
  const cameras=manifest.cameras.map(camera=>{
    const view=lookAt(camera.eye,camera.target,camera.up);
    const points=matrix.cases.filter(row=>row.cameraId===camera.id&&row.cascadeCount===1).flatMap(row=>{
      const instance=packet.instances.find(i=>i.id===row.instanceId)!;
      const material=packet.materials.find(m=>m.id===instance.material)!;
      return row.points.map(point=>{
        const p=point.worldPoint;
        const depth=-(view[2]!*p[0]+view[6]!*p[1]+view[10]!*p[2]+view[14]!);
        if(!(depth>0))throw Error("Frozen author fog point lies behind camera");
        const base=Array.from(material.baseColor).slice(0,3);
        const expected=Object.fromEntries(profile.scenarios.map(s=>[s.id,j3AuthorFogRgb(base,depth,s.density,profile.color,s.materialFog)]));
        return {pixel:point.pixel,instanceId:row.instanceId,worldPoint:p,depth,base,expected};
      });
    });
    return {...camera,points};
  });
  if(cameras.reduce((n,c)=>n+c.points.length,0)!==85)throw Error("Original 85-point masks changed");
  return {schema:"j3-author-fog-cpu-plan-v1",currentRun:false,packageHash:matrix.packageHash,
    packetHash:matrix.packetHash,width:matrix.width,height:matrix.height,profile,cameras};
}
