import type { DeepPbrMeshV1MaterialDefaults } from "@bim-studio/deep-engine/shader-authoring";
import type { PreparedShaderPackagePass } from "@bim-studio/deep-engine/webgpu";
import {
  PBR_PROBE_BYTES_PER_ROW, PBR_PROBE_CLEAR,
  PBR_PROBE_HEIGHT, PBR_PROBE_WIDTH, pbrProbeFrame, pbrProbeGeometry, pbrProbeInstance,
} from "./deepSlPbrProbeFixture.js";
import {
  clearCsmProbeLayers, readPbrProbeReadback, rgbaTexture, solidTexture, uploadBuffer, validateCsmProbe, validatePasses,
  type DeepSlPbrDrawOptions, type DeepSlPbrGpuSample,
} from "./deepSlPbrGpuDrawSupport.js";
export type { DeepSlPbrDrawOptions, DeepSlPbrGpuSample, DeepSlPbrMaterialTextureSource } from "./deepSlPbrGpuDrawSupport.js";

export async function drawDeepSlPbrCase(
  device: GPUDevice,
  forward: PreparedShaderPackagePass,
  shadow: PreparedShaderPackagePass,
  material: DeepPbrMeshV1MaterialDefaults,
  options: DeepSlPbrDrawOptions = {},
): Promise<DeepSlPbrGpuSample> {
  const textured = options.materialTextures !== undefined;
  validatePasses(forward, shadow, textured);
  validateCsmProbe(options);
  const csm = options.cascadedShadow;
  const buffers: GPUBuffer[] = [];
  const textures: GPUTexture[] = [];
  let readback: GPUBuffer | undefined;
  let shadowReadback: GPUBuffer | undefined;
  let scopeOpen = true;
  let submitted = false;
  const texture = (descriptor: GPUTextureDescriptor): GPUTexture => {
    const value = device.createTexture(descriptor); textures.push(value); return value;
  };
  const buffer = (label: string, data: Float32Array, usage: GPUBufferUsageFlags): GPUBuffer => {
    const value = uploadBuffer(device, label, data, usage); buffers.push(value); return value;
  };
  device.pushErrorScope("validation");
  try {
    const shadowMap = texture({
      label: "DeepSL package shadow map", size: [PBR_PROBE_WIDTH, PBR_PROBE_HEIGHT, csm ? 4 : 1],
      format: shadow.attachmentProfile.depthAttachment.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const colorMsaa = texture({
      label: "DeepSL package HDR MSAA", size: [PBR_PROBE_WIDTH, PBR_PROBE_HEIGHT],
      format: forward.attachmentProfile.colorAttachments[0]!.format,
      sampleCount: forward.attachmentProfile.sampleCount as 4,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const colorResolve = texture({
      label: "DeepSL package HDR resolve", size: [PBR_PROBE_WIDTH, PBR_PROBE_HEIGHT],
      format: forward.attachmentProfile.colorAttachments[0]!.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const depth = texture({
      label: "DeepSL package depth", size: [PBR_PROBE_WIDTH, PBR_PROBE_HEIGHT],
      format: forward.attachmentProfile.depthAttachment.format,
      sampleCount: forward.attachmentProfile.sampleCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const specular = solidTexture(device, "DeepSL package specular IBL", [26, 26, 26, 255], true);
    const diffuse = solidTexture(device, "DeepSL package diffuse IBL", [13, 13, 13, 255], true);
    const brdf = solidTexture(device, "DeepSL package BRDF LUT", [128, 5, 0, 255]);
    textures.push(specular, diffuse, brdf);

    const frameData = pbrProbeFrame();
    const geometryData = options.geometry ?? pbrProbeGeometry();
    if (geometryData.length !== 30 || geometryData.some((value) => !Number.isFinite(value))) {
      throw new Error("DeepSL package probe geometry must contain three finite geometry40 vertices.");
    }
    const instanceData = pbrProbeInstance(material);
    const frame = buffer("DeepSL package Frame208", frameData, GPUBufferUsage.UNIFORM);
    const cascadedShadow = csm ? buffer("DeepSL package CSM336", csm.uniform, GPUBufferUsage.UNIFORM) : undefined;
    const geometry = buffer("DeepSL package geometry40", geometryData, GPUBufferUsage.VERTEX);
    const instance = buffer("DeepSL package instance144", instanceData, GPUBufferUsage.VERTEX);
    let tangent: GPUBuffer | undefined;
    if (options.tangents) {
      if (options.tangents.length !== 12 || options.tangents.some((value) => !Number.isFinite(value))) {
        throw new Error("DeepSL package tangent stream must contain three finite float32x4 vertices.");
      }
      tangent = buffer("DeepSL package tangent16", options.tangents, GPUBufferUsage.VERTEX);
    }
    let forwardMaterialGroup: GPUBindGroup | undefined;
    let shadowMaterialGroup: GPUBindGroup | undefined;
    if (options.materialTextures) {
      if (options.materialTextures.parameters.length !== 40
        || options.materialTextures.parameters.some((value) => !Number.isFinite(value))) {
        throw new Error("DeepSL package material texture parameters must contain 40 finite f32 values.");
      }
      if (options.materialTextures.parameters[27]! > 0.5 && !tangent) {
        throw new Error("DeepSL package normal mapping requires the canonical tangent16 vertex stream.");
      }
      const materialParameters = buffer(
        "DeepSL package material160",
        new Float32Array(options.materialTextures.parameters),
        GPUBufferUsage.UNIFORM,
      );
      const materialSource = options.materialTextures;
      const baseColorMap = materialSource.baseColor
        ? rgbaTexture(device, "DeepSL package base-color sRGB", "rgba8unorm-srgb", materialSource.baseColor)
        : solidTexture(device, "DeepSL package dummy base-color sRGB", [255, 255, 255, 255], false, "rgba8unorm-srgb");
      const metallicRoughnessMap = materialSource.metallicRoughness
        ? rgbaTexture(device, "DeepSL package metallic-roughness linear", "rgba8unorm", materialSource.metallicRoughness)
        : solidTexture(device, "DeepSL package dummy metallic-roughness linear", [255, 255, 255, 255]);
      const occlusionMap = materialSource.occlusion
        ? rgbaTexture(device, "DeepSL package occlusion linear", "rgba8unorm", materialSource.occlusion)
        : solidTexture(device, "DeepSL package dummy occlusion linear", [255, 255, 255, 255]);
      const normalMap = materialSource.normal
        ? rgbaTexture(device, "DeepSL package normal linear", "rgba8unorm", materialSource.normal)
        : solidTexture(device, "DeepSL package dummy normal linear", [128, 128, 255, 255]);
      const emissiveMap = materialSource.emissive
        ? rgbaTexture(device, "DeepSL package emissive sRGB", "rgba8unorm-srgb", materialSource.emissive)
        : solidTexture(device, "DeepSL package dummy emissive sRGB", [0, 0, 0, 255], false, "rgba8unorm-srgb");
      textures.push(baseColorMap, metallicRoughnessMap, occlusionMap, normalMap, emissiveMap);
      const materialSampler = device.createSampler({ minFilter: "nearest", magFilter: "nearest" });
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: baseColorMap.createView() },
        { binding: 1, resource: materialSampler },
        { binding: 2, resource: metallicRoughnessMap.createView() },
        { binding: 3, resource: materialSampler },
        { binding: 4, resource: { buffer: materialParameters, size: 160 } },
        { binding: 5, resource: occlusionMap.createView() },
        { binding: 6, resource: materialSampler },
        { binding: 7, resource: normalMap.createView() },
        { binding: 8, resource: materialSampler },
        { binding: 9, resource: emissiveMap.createView() },
        { binding: 10, resource: materialSampler },
      ];
      forwardMaterialGroup = device.createBindGroup({
        label: "DeepSL package forward material", layout: forward.bindGroupLayouts[1]!, entries,
      });
      if (shadow.bindGroupLayouts.length === 2) {
        shadowMaterialGroup = device.createBindGroup({
          label: "DeepSL package shadow material", layout: shadow.bindGroupLayouts[1]!, entries,
        });
      }
    }
    readback = device.createBuffer({
      label: "DeepSL package rgba16 readback", size: PBR_PROBE_BYTES_PER_ROW * PBR_PROBE_HEIGHT,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    buffers.push(readback);
    shadowReadback = device.createBuffer({
      label: "DeepSL package depth32float readback", size: PBR_PROBE_BYTES_PER_ROW * PBR_PROBE_HEIGHT,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    buffers.push(shadowReadback);

    const shadowGroup = device.createBindGroup({
      label: "DeepSL package shadow frame", layout: shadow.bindGroupLayouts[0]!,
      entries: [{ binding: 0, resource: { buffer: frame, size: frameData.byteLength } }],
    });
    const forwardGroup = device.createBindGroup({
      label: "DeepSL package forward frame", layout: forward.bindGroupLayouts[0]!, entries: [
        { binding: 0, resource: { buffer: frame, size: frameData.byteLength } },
        { binding: 1, resource: shadowMap.createView({ dimension: csm ? "2d-array" : "2d" }) },
        { binding: 2, resource: device.createSampler({ compare: "less-equal" }) },
        { binding: 3, resource: specular.createView({ dimension: "cube" }) },
        { binding: 4, resource: diffuse.createView({ dimension: "cube" }) },
        { binding: 5, resource: brdf.createView() },
        { binding: 6, resource: device.createSampler({ minFilter: "linear", magFilter: "linear" }) },
        ...(cascadedShadow ? [{ binding: 7, resource: { buffer: cascadedShadow, size: 336 } }] : []),
      ],
    });

    const encoder = device.createCommandEncoder({ label: "DeepSL package shadow + forward" });
    if (csm) clearCsmProbeLayers(encoder, shadowMap, csm.clearDepths);
    const shadowPass = encoder.beginRenderPass({
      label: "DeepSL package shadow", colorAttachments: [],
      depthStencilAttachment: {
        view: shadowMap.createView({ dimension: "2d", baseArrayLayer: csm?.shadowLayer ?? 0, arrayLayerCount: 1 }), depthClearValue: 1,
        depthLoadOp: "clear", depthStoreOp: "store",
      },
    });
    shadowPass.setPipeline(shadow.pipeline); shadowPass.setBindGroup(0, shadowGroup);
    if (shadowMaterialGroup) shadowPass.setBindGroup(1, shadowMaterialGroup);
    shadowPass.setVertexBuffer(0, geometry); shadowPass.setVertexBuffer(1, instance);
    shadowPass.draw(3, 1); shadowPass.end();

    const forwardPass = encoder.beginRenderPass({
      label: "DeepSL package forward", colorAttachments: [{
        view: colorMsaa.createView(), resolveTarget: colorResolve.createView(),
        loadOp: "clear", storeOp: "discard",
        clearValue: { r: PBR_PROBE_CLEAR[0], g: PBR_PROBE_CLEAR[1], b: PBR_PROBE_CLEAR[2], a: 1 },
      }],
      depthStencilAttachment: {
        view: depth.createView(), depthClearValue: 1,
        depthLoadOp: "clear", depthStoreOp: "discard",
      },
    });
    forwardPass.setPipeline(forward.pipeline); forwardPass.setBindGroup(0, forwardGroup);
    if (forwardMaterialGroup) forwardPass.setBindGroup(1, forwardMaterialGroup);
    forwardPass.setVertexBuffer(0, geometry); forwardPass.setVertexBuffer(1, instance);
    if (tangent) forwardPass.setVertexBuffer(2, tangent);
    forwardPass.draw(3, 1); forwardPass.end();
    encoder.copyTextureToBuffer(
      { texture: colorResolve },
      { buffer: readback, bytesPerRow: PBR_PROBE_BYTES_PER_ROW, rowsPerImage: PBR_PROBE_HEIGHT },
      [PBR_PROBE_WIDTH, PBR_PROBE_HEIGHT],
    );
    encoder.copyTextureToBuffer(
      { texture: shadowMap, aspect: "depth-only", origin: [0, 0, csm?.shadowLayer ?? 0] },
      { buffer: shadowReadback, bytesPerRow: PBR_PROBE_BYTES_PER_ROW, rowsPerImage: PBR_PROBE_HEIGHT },
      [PBR_PROBE_WIDTH, PBR_PROBE_HEIGHT],
    );
    device.queue.submit([encoder.finish()]); submitted = true;
    await Promise.all([readback.mapAsync(GPUMapMode.READ), shadowReadback.mapAsync(GPUMapMode.READ)]);
    const { raw16, pixel, samplePixels } = readPbrProbeReadback(readback, options.samplePoints);
    const shadowOffset = Math.floor(PBR_PROBE_HEIGHT / 2) * PBR_PROBE_BYTES_PER_ROW
      + Math.floor(PBR_PROBE_WIDTH / 2) * 4;
    const shadowDepth = new DataView(shadowReadback.getMappedRange(), shadowOffset, 4).getFloat32(0, true);
    readback.unmap();
    shadowReadback.unmap();
    const validationError = await device.popErrorScope(); scopeOpen = false;
    if (validationError) throw new Error(`DeepSL package GPU validation failed: ${validationError.message}`);
    return Object.freeze({
      raw16, pixel,
      frameBytes: frameData.byteLength as 208,
      geometryStride: (geometryData.byteLength / 3) as 40,
      instanceStride: instanceData.byteLength as 144,
      shadowDraws: 1, forwardDraws: 1, resolveUsed: true,
      colorFormat: forward.attachmentProfile.colorAttachments[0]!.format,
      sampleCount: forward.attachmentProfile.sampleCount as 4,
      forwardDepthFormat: forward.attachmentProfile.depthAttachment.format as "depth24plus",
      shadowDepthFormat: shadow.attachmentProfile.depthAttachment.format as "depth32float",
      shadowDepth,
      ...(samplePixels ? { samplePixels } : {}),
    });
  } finally {
    if (scopeOpen) {
      try { await device.popErrorScope(); } catch { /* Preserve the first GPU failure. */ }
    }
    if (submitted) {
      try { await device.queue.onSubmittedWorkDone(); } catch { /* Device loss owns the failure. */ }
    }
    if (readback?.mapState === "mapped") readback.unmap();
    if (shadowReadback?.mapState === "mapped") shadowReadback.unmap();
    for (const value of buffers) value.destroy();
    for (const value of textures) value.destroy();
  }
}
