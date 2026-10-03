import type { RenderPacket } from "../renderPacket.js";
import type { DynamicPhysicsRuntime } from "../runtimePackage/dynamicSceneRuntime.js";
import { createSoftBodyRuntimeSession } from "../physics/softBodyRuntimeHost.js";
import { generateNormals } from "../gltf/generatedNormals.js";

/** Same registered CPU cloth/cuboid input; render only the selected stream geometry. */
export const bindings = [{bodyId:"cloth",instanceId:"cloth",vertexParticles:Array.from({length:72},(_,i)=>i)}];
export function makeSession() {
  const physics:DynamicPhysicsRuntime={schema:"deep-engine.physics-runtime",schemaVersion:1,
    enabled:true,playing:true,gravity:[0,-9.81,0],joints:[],softBodies:[{
      kind:"cloth",id:"cloth",columns:9,rows:8,spacing:.1,mass:.2,compliance:0,damping:.01,
      substeps:16,perturbation:.001,seed:7,origin:[-.4,0,0],pinned:[63,71],
      wind:{direction:[0,0,-1],baseSpeed:.2,gustFrequency:.7,spatialScale:1.5,seed:11},
    }],bodies:[{id:"obstacle",type:"fixed",mass:1,friction:0,restitution:0,
      initialPose:{translation:[0,-.25,0],rotation:[0,0,0,1]},
      collider:{kind:"primitive",instanceIds:[],primitive:{shape:"cuboid",halfExtents:[10,.25,10]}},
    }]};
  return createSoftBodyRuntimeSession(physics,{collisionBodyIds:["obstacle"]});
}
export function makePacket(positions:Float64Array):RenderPacket {
  const indices:number[]=[];
  for(let row=0;row<7;row++)for(let col=0;col<8;col++){
    const a=row*9+col,b=a+9;indices.push(a,a+1,b,a+1,b+1,b);
  }
  const topology=new Uint32Array(indices),xyz=new Float32Array(positions),normals=generateNormals(xyz,topology,"f6-stream");
  const vertices=new Float32Array(72*6);
  for(let i=0;i<72;i++)for(let axis=0;axis<3;axis++){
    vertices[i*6+axis]=xyz[i*3+axis]!;vertices[i*6+3+axis]=normals[i*3+axis]!;
  }
  return {geometries:[{id:"cloth",revision:0,vertices,indices:topology}],
    materials:[{id:"fabric",baseColor:[1,1,1],metallic:0,roughness:.8,doubleSided:true}],
    instances:[{id:"cloth",geometry:"cloth",material:"fabric",transform:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}]};
}
