import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildDeepRuntimePackage, buildDeepRuntimePackageArtifact, buildDeepRuntimePackageArtifactAsync, serializeDeepRuntimePackage } from "./index.js";
import type { RenderPacket } from "../renderPacketTypes.js";

function input() {
  const packet = JSON.parse(readFileSync(new URL("../../../deep-engine-native/fixtures/render_packet_v1.json",import.meta.url),"utf8"));
  for(const geometry of packet.geometries) {
    geometry.vertices = new Float32Array(geometry.vertices);
    geometry.indices = new Uint32Array(geometry.indices);
  }
  return {packageId:"artifact.validated",packageVersion:"0.2.0",renderPacket:{id:"scene",revision:1,value:packet as RenderPacket}};
}
it("serializes only its own just-validated snapshot with identical public wire bytes",()=>{
  const source=input(), artifact=buildDeepRuntimePackageArtifact(source), ordinary=buildDeepRuntimePackage(source);
  expect(artifact.runtimePackage).toEqual(ordinary);
  expect(artifact.packageJson).toBe(serializeDeepRuntimePackage(ordinary));
  (artifact.runtimePackage.payloads.scene as {version:number}).version=9;
  expect(()=>serializeDeepRuntimePackage(artifact.runtimePackage)).toThrow();
});
it("does not bypass package source validation",()=>{
  const source=input(); (source.renderPacket.value.materials[0]! as {roughness:number}).roughness=3;
  expect(()=>buildDeepRuntimePackageArtifact(source)).toThrow();
});
it("produces the same native WebCrypto digest and wire as the public synchronous contract",async()=>{
  expect(globalThis.crypto?.subtle).toBeDefined();
  const source=input(), ordinary=buildDeepRuntimePackageArtifact(source);
  const artifact=await buildDeepRuntimePackageArtifactAsync(source);
  expect(artifact).toMatchObject(ordinary);
  expect(new TextDecoder().decode(artifact.packageBytes)).toBe(ordinary.packageJson);
  expect(serializeDeepRuntimePackage(artifact.runtimePackage)).toBe(artifact.packageJson);
  (artifact.runtimePackage.payloads.scene as {version:number}).version=9;
  expect(()=>serializeDeepRuntimePackage(artifact.runtimePackage)).toThrow();
});
it("owns all caller data before the first asynchronous digest yields",async()=>{
  const source=input();
  const bindings=[{nodeId:"author",instanceIds:[source.renderPacket.value.instances[0]!.id]}];
  const packet={...source.renderPacket.value,objectBindings:bindings};
  const ownedInput={...source,renderPacket:{...source.renderPacket,value:packet}};
  const ordinary=buildDeepRuntimePackageArtifact(ownedInput);
  const pending=buildDeepRuntimePackageArtifactAsync(ownedInput);
  (packet.materials[0]! as {roughness:number}).roughness=3;
  bindings[0]!.nodeId="changed";
  bindings[0]!.instanceIds.push("late");
  expect(await pending).toMatchObject(ordinary);
});
it("rejects cancellation during the digest without publishing an artifact",async()=>{
  const controller=new AbortController();
  const pending=buildDeepRuntimePackageArtifactAsync(input(),{signal:controller.signal});
  controller.abort();
  await expect(pending).rejects.toMatchObject({name:"AbortError"});
});
it("keeps strict source validation in the asynchronous constructor",async()=>{
  const source=input(); (source.renderPacket.value.materials[0]! as {roughness:number}).roughness=3;
  await expect(buildDeepRuntimePackageArtifactAsync(source)).rejects.toThrow();
});
