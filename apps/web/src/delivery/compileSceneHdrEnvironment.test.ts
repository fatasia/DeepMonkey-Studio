import {expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {compileSceneHdrDescriptor} from "./compileSceneHdrEnvironment";
import {compileSceneRuntimePackage} from "./compileSceneRuntimePackage";
import {assessCompiledScenePublication} from "./scenePublicationCompatibility";
import {parseDeepRuntimePackage,type RuntimePrefilteredIbl} from "@bim-studio/deep-engine/runtime-package";
import type {SceneSnapshot} from "@bim-studio/contracts";
const environment={skybox:"none",gridVisible:false,backgroundColor:"#172126",environmentMapUrl:"/assets/projects/p/studio.hdr",environmentAsBackground:false,environmentIntensity:1};
const lighting={enabled:true,intensity:1,reflectionsEnabled:true,shadowsEnabled:true,globalIlluminationEnabled:false,
  lights:[{id:"sun",name:"Sun",type:"directional",enabled:true,color:"#ffffff",intensity:1,castShadow:true}]};
it("HDR author semantics reject background panorama and unsupported GI without changing old profiles",()=>{
  expect(compileSceneHdrDescriptor(environment,lighting)?.schemaVersion).toBe(6);
  for(const patch of [{environmentAsBackground:true},{environmentIntensity:Infinity},{environmentIntensity:65},{environmentMapUrl:""}]) expect(compileSceneHdrDescriptor({...environment,...patch},lighting)).toBeUndefined();
  expect(compileSceneHdrDescriptor(environment,{...lighting,globalIlluminationEnabled:true})).toBeUndefined();
  expect(compileSceneHdrDescriptor(environment,{...lighting,reflectionsEnabled:false})).toBeUndefined();
});
it("freezes HDR source identity, lighting and prefiltered payload into v11",async()=>{
  const fixture=JSON.parse(readFileSync(new URL("../../../../packages/deep-engine-native/tests/fixtures/runtime-package-prefiltered-ibl-v1.json",import.meta.url),"utf8"));
  const payload={...fixture.payloads[fixture.entrypoints.environment],id:"scene.environment"} as RuntimePrefilteredIbl;
  const scene={schemaVersion:1,id:"s",projectId:"p",name:"s",models:[],primitives:[],measurements:[],environment,lighting,
    camera:{mode:"orbit",position:{x:0,y:1,z:5},target:{x:0,y:0,z:0}},createdAt:"",updatedAt:""} as SceneSnapshot;
  const options={packageId:"scene",packageVersion:"1.0.0",loadModel:async()=>new Uint8Array(),hdrEnvironment:{payload,source:{bytes:1024,sha256:payload.source.contentHash.value}}};
  const result=await compileSceneRuntimePackage(scene,options);
  expect(result.evidence.recipe).toBe("deep-scene-static-compile-v11");
  expect(parseDeepRuntimePackage(result.packageJson).valid).toBe(true);
  expect(result.evidence.deferredSceneFields).not.toContain("environment");
  const assess=(compilation:typeof result.evidence)=>assessCompiledScenePublication(scene,{compilation,fixtureId:"f",platform:"windows-x64"});
  expect(assess(result.evidence).items.find(item=>item.path==="environment")?.capability).toBe("deep.scene.hdr-environment.v1");
  expect(assess({...result.evidence,environmentSource:undefined} as unknown as typeof result.evidence).status).toBe("blocked");
  expect(assess({...result.evidence,recipe:"deep-scene-static-compile-v10"}).status).toBe("blocked");
  await expect(compileSceneRuntimePackage(scene,{...options,hdrEnvironment:{payload,source:{bytes:1024,sha256:"b".repeat(64)}}})).rejects.toThrow("HDR");
});
