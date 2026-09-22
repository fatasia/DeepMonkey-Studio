// A01-X Babylon pairing vendor entry. Bundles @babylonjs/core@9.26.1 (full package, so every
// scene-component/shader side-effect registration ships) and re-exports the surface the Deep
// lab pairing adapter consumes. Babylon stays outside the workspace dependency graph; this
// file lives in the isolated directory and is bundled at gate time into test-output.
import * as BabylonCore from "@babylonjs/core/index.js";

export const WebGPUEngine = BabylonCore.WebGPUEngine;
export const Scene = BabylonCore.Scene;
export const FreeCamera = BabylonCore.FreeCamera;
export const Vector3 = BabylonCore.Vector3;
export const Color3 = BabylonCore.Color3;
export const Color4 = BabylonCore.Color4;
export const DirectionalLight = BabylonCore.DirectionalLight;
export const PBRMaterial = BabylonCore.PBRMaterial;
export const StandardMaterial = BabylonCore.StandardMaterial;
export const Mesh = BabylonCore.Mesh;
export const VertexData = BabylonCore.VertexData;
export const ShadowGenerator = BabylonCore.ShadowGenerator;
export const Logger = BabylonCore.Logger;
export const MeshBuilder = BabylonCore.MeshBuilder;
export const BABYLON_VENDOR_VERSION = "9.26.1";
