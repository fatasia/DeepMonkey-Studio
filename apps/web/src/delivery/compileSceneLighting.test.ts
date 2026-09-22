import { describe, expect, it } from "vitest";
import { compileSceneLighting } from "./compileSceneLighting";
import { compileSceneRuntimePackage } from "./compileSceneRuntimePackage";
import { assessCompiledScenePublication } from "./scenePublicationCompatibility";
import { parseDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import type { SceneSnapshot } from "@bim-studio/contracts";
const source = () => ({ enabled: true, intensity: 1, shadowsEnabled: true, reflectionsEnabled: false, globalIlluminationEnabled: false,
  lights: [{ id: "sun", name: "Sun", type: "directional", enabled: true, color: "#ffffff", intensity: 2,
    position: { x: 0, y: 6, z: 0 }, target: { x: 0, y: 0, z: 0 }, castShadow: true }] });
describe("authored directional light", () => {
  it("publishes hemisphere ground RGB and world direction without translation", async () => {
    const lighting = { ...source(), lights: [{ id: "hemi", name: "Hemisphere", type: "hemisphere", enabled: true,
      color: "#ff0000", groundColor: "#0080ff", intensity: 2, position: { x: 0, y: -3, z: 0 }, target: { x: 7, y: 2, z: 8 }, castShadow: false }] };
    const light = compileSceneLighting(lighting, undefined, { x: 10000, y: 0, z: 20000 })?.localLights?.[0];
    expect(light).toMatchObject({ kind: "hemisphere", position: [0,0,0], direction: [0,-1,0], radiance: [2,0,0] });
    expect(light?.groundRadiance?.[1]).toBeCloseTo(0.431721);
    expect(light?.groundRadiance?.[2]).toBe(2);
    const snapshot = { schemaVersion: 1, id: "hemi-scene", projectId: "p", name: "Hemisphere", models: [], primitives: [], annotations: [], measurements: [],
      camera: { mode: "orbit", position: { x: 0, y: 1, z: 5 }, target: { x: 0, y: 0, z: 0 } }, createdAt: "", updatedAt: "",
      environment: { skybox: "none", gridVisible: false, backgroundColor: "#172126" }, lighting } as unknown as SceneSnapshot;
    const result = await compileSceneRuntimePackage(snapshot, { packageId: "scene.hemi", packageVersion: "1.0.0", loadModel: async () => new Uint8Array() });
    expect(parseDeepRuntimePackage(result.packageJson).valid).toBe(true);
    expect(result.evidence.deferredSceneFields).not.toContain("lighting");
    const publication = assessCompiledScenePublication(snapshot, { compilation: result.evidence, fixtureId: "hemisphere", platform: "windows-x64" });
    expect(publication.items.find(item => item.path === "lighting")?.capability).toBe("deep.scene.multi-light.v1");
    expect(result.runtimePackage.payloads["scene.environment"]).toMatchObject({ lighting: { localLights: [{ kind: "hemisphere", groundRadiance: [0,expect.any(Number),2] }] } });
  });
  it("freezes world direction, linear radiance, shadow choice and Web exposure together", () => {
    expect(compileSceneLighting(source())).toEqual({ direction: [0,1,0], radiance: [2,2,2], exposure: 1.05, shadows: true });
    const disabled = source(); disabled.enabled = false;
    expect(compileSceneLighting(disabled)).toMatchObject({ radiance: [0,0,0], exposure: .55 });
    const high = source(); high.intensity = 16;
    expect(compileSceneLighting(high)?.exposure).toBe(1.55);
    high.lights[0]!.color = "#808080";
    expect(compileSceneLighting(high)?.radiance[0]).toBeCloseTo(6.907536);
  });
  it("preserves the authored GI multiplier in the builtin IBL runtime contract", () => {
    const state = { ...source(), reflectionsEnabled: true, globalIlluminationEnabled: true, globalIlluminationIntensity: 2.5 };
    expect(compileSceneLighting(state, undefined, undefined, true)).toMatchObject({ globalIlluminationIntensity: 2.5 });
  });
  it.each([{ lights: [] }, { reflectionsEnabled: true }, { globalIlluminationEnabled: true }, { intensity: NaN },
    { intensity: 17 }, { unknown: true }, { shadowsEnabled: undefined }])("does not silently lose semantics %o", patch => {
    expect(compileSceneLighting({ ...source(), ...patch })).toBeUndefined();
  });
  it("rejects unsupported additional shadows, zero direction and unsupported weather", () => {
    const state = source(); state.lights.push({ ...state.lights[0]!, id: "second" });
    expect(compileSceneLighting(state)).toBeUndefined();
    state.lights.pop(); state.lights[0]!.position = { x: 0, y: 0, z: 0 };
    expect(compileSceneLighting(state)).toBeUndefined();
    expect(compileSceneLighting(source(), "cloudy")).toBeUndefined();
  });
  it("compiles point and spot with local origin, attenuation and cone intact", () => {
    const local = { id: "point", name: "Point", type: "point", enabled: true, color: "#ff0000", intensity: 4,
      position: { x: 10002, y: 6, z: -20000 }, castShadow: false, distance: 12, decay: 2 };
    const state = { ...source(), lights: [...source().lights, local, { ...local, id: "spot", type: "spot",
      target: { x: 10002, y: 0, z: -20000 }, angle: Math.PI/4, penumbra: .5 }] };
    const result = compileSceneLighting(state, undefined, { x: 10000, y:0, z:-20000 });
    expect(result?.localLights?.[0]).toMatchObject({ kind:"point", position:[2,6,0], radiance:[4,0,0],range:12,decay:2 });
    expect(result?.localLights?.[1]?.direction).toEqual([-0,-1,-0]);
    expect(result?.localLights?.[1]?.innerCos).toBeCloseTo(Math.cos(Math.PI/8));
    expect(result?.localLights?.[1]?.outerCos).toBeCloseTo(Math.cos(Math.PI/4));
    expect(compileSceneLighting({ ...state, lights: [...state.lights, local] })).toBeUndefined();
    expect(compileSceneLighting({ ...state, lights: [{ ...local, castShadow:true }] })?.localLights?.[0]?.castShadow).toBe(true);
    expect(compileSceneLighting({ ...state, lights: [{ ...local, castShadow:true }, { ...local, id:"second-shadow-point", castShadow:true }] })).toBeUndefined();
    expect(compileSceneLighting({ ...state, lights: [{ ...local, decay:5 }] })).toBeUndefined();
  });
  it("compiles persisted IES profiles and spot references into the formal environment ABI", async () => {
    const profile = { profileId: "ies-factory", format: "LM-63-2002", verticalAngles: [0, 45, 90],
      candela: [[1000, 500, 100]], horizontalSymmetry: 1, totalLumens: 1234.5 } as const;
    const spot = { id: "spot", name: "IES spot", type: "spot", enabled: true, color: "#ffffff", intensity: 4,
      position: { x: 0, y: 4, z: 0 }, target: { x: 0, y: 0, z: 0 }, castShadow: false,
      distance: 12, decay: 2, angle: Math.PI / 4, penumbra: .5,
      ies: { profileId: "ies-factory", rotationDeg: 45, scaleFactor: .75 } };
    const result = compileSceneLighting({ ...source(), lights: [...source().lights, spot], lightProfiles: [profile] });
    expect(result?.lightProfiles).toEqual([profile]);
    expect(result?.localLights?.[0]?.ies).toEqual({ profileId: "ies-factory", rotationDeg: 45, scaleFactor: .75 });
    expect(compileSceneLighting({ ...source(), lights: [...source().lights, { ...spot, ies: { profileId: "missing" } }], lightProfiles: [profile] }))
      .toBeUndefined();
    expect(compileSceneLighting({ ...source(), lights: [...source().lights, { ...spot, ies: { ...spot.ies, rotationDeg: 45.25 } }], lightProfiles: [profile] }))
      .toBeUndefined();
    const scene = { schemaVersion: 1, id: "ies-scene", projectId: "p", name: "IES", models: [], primitives: [], measurements: [],
      camera: { mode: "orbit", position: { x: 0, y: 1, z: 5 }, target: { x: 0, y: 0, z: 0 } },
      environment: { skybox: "none", gridVisible: false, backgroundColor: "#172126" },
      lighting: { ...source(), lights: [...source().lights, spot], lightProfiles: [{ ...profile,
        verticalAngles: [...profile.verticalAngles], candela: profile.candela.map(row => [...row]) }] },
      createdAt: "", updatedAt: "" } as SceneSnapshot;
    const compiled = await compileSceneRuntimePackage(scene,
      { packageId: "scene.ies", packageVersion: "1.0.0", loadModel: async () => new Uint8Array() });
    expect(parseDeepRuntimePackage(compiled.packageJson).valid).toBe(true);
    expect(compiled.runtimePackage.payloads["scene.environment"]).toMatchObject({ lighting: {
      lightProfiles: [{ profileId: "ies-factory" }], localLights: [{ ies: { profileId: "ies-factory" } }],
    } });
  });
  it("publishes only v7 evidence with both source fields and fails erased claims", async () => {
    const scene = { schemaVersion: 1, id: "s", projectId: "p", name: "s", models: [], primitives: [], measurements: [],
      camera: { mode: "orbit", position: { x: 0, y: 1, z: 5 }, target: { x: 0, y: 0, z: 0 } },
      environment: { skybox: "none", gridVisible: false, backgroundColor: "#172126" }, lighting: source(),
      createdAt: "", updatedAt: "" } as SceneSnapshot;
    const result = await compileSceneRuntimePackage(scene, { packageId: "scene", packageVersion: "1.0.0", loadModel: async () => new Uint8Array() });
    expect(result.evidence.recipe).toBe("deep-scene-static-compile-v7");
    expect(result.evidence.deferredSceneFields).not.toContain("lighting");
    const options = { compilation: result.evidence, fixtureId: "f", platform: "windows-x64" };
    expect(assessCompiledScenePublication(scene, options).items.find(item => item.path === "lighting")?.capability).toBe("deep.scene.directional-light.v1");
    const erased = { ...result.evidence, compiledSceneFields: result.evidence.compiledSceneFields.filter(field => field.field !== "lighting") };
    expect(assessCompiledScenePublication(scene, { ...options, compilation: erased }).status).toBe("blocked");
    expect(assessCompiledScenePublication(scene, { ...options, compilation: { ...result.evidence, recipe: "deep-scene-static-compile-v6" } }).status).toBe("blocked");
    const manyScene = { ...scene, lighting: { ...source(), lights: [...source().lights,
      { id:"point",name:"Point",type:"point",enabled:true,color:"#ff0000",intensity:2,castShadow:false,position:{x:2,y:4,z:0},distance:12,decay:2 }] } } as SceneSnapshot;
    const many = await compileSceneRuntimePackage(manyScene, { packageId:"scene",packageVersion:"1.0.0",loadModel:async()=>new Uint8Array() });
    expect(many.evidence.recipe).toBe("deep-scene-static-compile-v8");
    expect(assessCompiledScenePublication(manyScene,{ ...options,compilation:many.evidence }).items.find(item=>item.path==="lighting")?.capability).toBe("deep.scene.multi-light.v1");
    expect(assessCompiledScenePublication(manyScene,{ ...options,compilation:{...many.evidence,recipe:"deep-scene-static-compile-v7"} }).status).toBe("blocked");
    const shadowScene = { ...scene, lighting:{...source(),lights:[...source().lights,
      {id:"spot",name:"Spot",type:"spot",enabled:true,color:"#ffffff",intensity:4,castShadow:true,shadowSoftness:.75,position:{x:0,y:4,z:0},target:{x:0,y:0,z:0},distance:12,angle:.6,penumbra:.2,decay:2}]} } as SceneSnapshot;
    const shadow = await compileSceneRuntimePackage(shadowScene,{packageId:"scene",packageVersion:"1.0.0",loadModel:async()=>new Uint8Array()});
    expect(shadow.evidence.recipe).toBe("deep-scene-static-compile-v9");
    expect(parseDeepRuntimePackage(shadow.packageJson).valid).toBe(true);
    expect(shadow.runtimePackage.payloads["scene.environment"]).toMatchObject({ lighting: { localLights: [{ shadowSoftness: .75 }] } });
    expect(assessCompiledScenePublication(shadowScene,{...options,compilation:shadow.evidence}).items.find(item=>item.path==="lighting")?.capability).toBe("deep.scene.spot-shadow.v1");
    expect(assessCompiledScenePublication(shadowScene,{...options,compilation:{...shadow.evidence,recipe:"deep-scene-static-compile-v8"}}).status).toBe("blocked");
    const pointScene={...manyScene,lighting:{...manyScene.lighting!,lights:manyScene.lighting!.lights!.map(light=>({...light,castShadow:true}))}} as SceneSnapshot;
    const point=await compileSceneRuntimePackage(pointScene,{packageId:"scene",packageVersion:"1.0.0",loadModel:async()=>new Uint8Array()});
    expect(point.evidence.recipe).toBe("deep-scene-static-compile-v10");
    expect(assessCompiledScenePublication(pointScene,{...options,compilation:point.evidence}).items.find(item=>item.path==="lighting")?.capability).toBe("deep.scene.point-shadow.v1");
    expect(assessCompiledScenePublication(pointScene,{...options,compilation:{...point.evidence,recipe:"deep-scene-static-compile-v9"}}).status).toBe("blocked");
  });
  it("enforces four spot shadow budget and preserves unshadowed v8", () => {
    const spot = { id:"spot",name:"Spot",type:"spot",enabled:true,color:"#ffffff",intensity:4,castShadow:true,
      position:{x:0,y:4,z:0},target:{x:0,y:0,z:0},distance:12,angle:.6,penumbra:.2,decay:2 };
    const state = { ...source(),lights:Array.from({length:4},(_,i)=>({...spot,id:`spot-${i}`})) };
    expect(compileSceneLighting(state)?.localLights?.filter(light=>light.castShadow)).toHaveLength(4);
    expect(compileSceneLighting({...state,lights:[...state.lights,{...spot,id:"fifth"}]})).toBeUndefined();
    expect(compileSceneLighting({...state,shadowsEnabled:false})?.localLights?.some(light=>light.castShadow)).toBe(false);
    expect(compileSceneLighting({...state,lights:[{...spot,angle:Math.PI/2}]})).toBeUndefined();
    const shifted={...spot,position:{x:100000,y:200004,z:-300000},target:{x:100000,y:200000,z:-300000}};
    expect(compileSceneLighting({...state,lights:[shifted]},undefined,{x:100000,y:200000,z:-300000}))
      .toEqual(compileSceneLighting({...state,lights:[spot]}));
  });
});
