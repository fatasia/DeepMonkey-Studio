import { expect, it } from "vitest";
import { ShaderChunk } from "three";
import { sceneShader } from "../src/webgpu/pbrShader.js";
import { observeDeepExplicitDerivative } from "./c8ExplicitDerivativeShader.js";
import { prepareExplicitDerivativeObservation } from "./c8ExplicitDerivativeProbe.js";

it("submits the isolated candidate through the original device and restores observer hooks", async () => {
  const chunks = { ...ShaderChunk }, originalChunks = { ...chunks }, submitted: GPUShaderModuleDescriptor[] = [];
  const device = { createShaderModule(input: GPUShaderModuleDescriptor) { submitted.push(input); return {}; }, destroy() {} } as unknown as GPUDevice;
  const original = device.createShaderModule, adapter = { requestDevice: async () => device } as unknown as GPUAdapter;
  const gpu = { requestAdapter: async () => adapter } as unknown as GPU;
  const observer = prepareExplicitDerivativeObservation("abs-dx", gpu, chunks);
  const delivered = await (await observer.gpu.requestAdapter())!.requestDevice();
  expect(delivered).toBe(device);
  delivered.createShaderModule({ label: "Deep PBR", code: sceneShader });
  expect(submitted[0]!.code).toBe(observeDeepExplicitDerivative("abs-dx").code);
  observer.recordThreeFragments([chunks.lights_physical_pars_fragment + chunks.lights_physical_fragment + "gl_FragColor = vec4( deepObservedFragment, diffuseColor.a )"]);
  const receipt = observer.receipt();
  expect(receipt.deep.replacedModules).toBe(1);
  expect(receipt.deep.instrumentedHash).toBe(observeDeepExplicitDerivative("abs-dx").instrumentedHash);
  expect(receipt.derivative).toBe("affine-numerator-bottom-row-left-column");
  expect(receipt.threeDerivative).toBe("default");
  expect(() => delivered.createShaderModule({ label: "Deep PBR", code: sceneShader + "\n" })).toThrow("differs");
  observer.dispose(); observer.dispose();
  expect(device.createShaderModule).toBe(original);
  expect(chunks).toEqual(originalChunks);
});

it("requires actual submission and GL compile receipts", () => {
  const observer = prepareExplicitDerivativeObservation("geometry", { requestAdapter: async () => null } as unknown as GPU, { ...ShaderChunk });
  expect(() => observer.receipt()).toThrow("Empty actual");
  observer.dispose();
});
