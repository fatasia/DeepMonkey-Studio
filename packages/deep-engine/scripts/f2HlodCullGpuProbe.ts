/// <reference types="@webgpu/types" />
/**
 * F2/驻留感知 HLOD 冻结场景真机对照 probe(由 scripts/f2HlodCullGpuTest.mjs 驱动;
 * 骨架同 clusterLodGpuTest.mjs / clothParallelGpuTest.mjs:headless Chrome + --enable-unsafe-webgpu。
 * 本模块只 import 浏览器安全源(共享叶子模块 + 生产 src),node:fs 链留在 f2HlodCullPayload.ts)。
 *
 * 三腿证据(冻结场景,单帧,离屏;帧时类禁测):
 *   a. 对象 ID 两态对照:同一冻结相机,全量实例腿(A:真实 GLB 节点世界 AABB 盒 ×N)
 *      vs HLOD 折叠腿(B:生产 threeBridge.applyHlodPlanToInstances 输出 = 隐藏成员 1e-6 缩放
 *      + 代理网格追加),r32uint 对象 ID 附件逐像素读回对比:
 *        - 覆盖真缺(像素级 miss,B 膨胀 1px 后仍空)= 必须为 0(代理保守超集);
 *        - 隐藏成员像素(B 携带该相机隐藏集成员 id)= 必须为 0(1e-6 缩放零像素);
 *        - 未折叠区成员 id 一致率、代理超悬、代理替代像素 = 如实计量,不设美化门限。
 *   b. 轮廓对比 = 两态覆盖掩码差异像素计数(missRaw + overhang),如实记录。
 *   c. 时序 Hi-Z 帧内锚点:远档全量腿冻结深度 → 生产 HiZPyramid 构建 → 逐 mip 读回与
 *      生产 CPU 孪生(instanceVisibilityTwin.buildDepthPyramid)逐位对拍。
 *      跨帧 previousHiZ × 折叠交互不在本 probe scope(登记留项,见 progress-01-survey.json)。
 *
 * 诚实边界:ID/轮廓 pass 为 probe 自持 WGSL——生产渲染侧没有 GPU 对象 ID 附件通道,
 * 也没有 hlod-proxy 独立 pass(见 batchBench realGpuChecklist,他人在途域);但两态实例表
 * 来自生产 applyHlodPlanToInstances,变换打包来自生产 packTransform,Hi-Z 金字塔与 CPU
 * 孪生均为生产单源。T26 削减率为计划层账目(hlodProxyDrawCost,与 batchBench 同源)+
 * 真机零像素佐证,非帧时测量。
 *
 * sourceSizeGate 拆分(2026-10-03):按职责分文件,代码逐行同源仅改可见性,语义零变化;
 * 本文件保留 runner 合同入口 runF2HlodCullGpuProbe:
 *   ID WGSL/编解码/会话/矩阵/几何拼接/实例打包/读回/膨胀 → f2HlodCullGpuProbeRender.ts。
 */
import { applyHlodPlanToInstances, HLOD_PROXY_MATERIAL_ID } from "../src/threeBridge/hlodClusterStream.js";
import { HiZPyramid } from "../src/webgpu/hiZPyramid.js";
import { buildDepthPyramid } from "../src/webgpu/instanceVisibilityTwin.js";
import { F2_MATERIAL_ID, F2_MEMBER_GEOMETRY_KEY, F2_VIEWPORT_HEIGHT, F2_VIEWPORT_WIDTH,
  type F2CameraOutcome, type F2HiZLevelOutcome, type F2HiZOutcome, type F2Payload,
  type F2ProbeResult } from "./f2HlodCullShared.js";
import { ID_WGSL, PIXELS, MEMBER_ID_BASE, f32FromB64, u32FromB64, sha256Hex,
  openF2Session, viewProjectionMatrix, concatGeometries, packInstanceRows,
  readbackAttachment, dilate, type GeometrySlot, type PackedInstances } from "./f2HlodCullGpuProbeRender.js";

export async function runF2HlodCullGpuProbe(payload: F2Payload): Promise<F2ProbeResult> {
  if (payload.schema !== "f2-hlod-cull-payload-v1") throw new Error(`unexpected payload ${payload.schema}.`);
  const ids = payload.ids;
  const memberCount = ids.length;
  const proxyIdBase = 1 + memberCount;
  const idToIndex = new Map(ids.map((id, index) => [id, index] as const));
  const { session, adapter, deviceErrors } = await openF2Session();
  const browserVersion = "headless-chrome";
  const userAgent = navigator.userAgent;
  try {
    const device = session.device;
    const { positionsBuffer, indicesBuffer, slots } = concatGeometries(device, payload);
    const memberTransforms = f32FromB64(payload.memberTransformsB64);
    const memberSlot = slots.get(F2_MEMBER_GEOMETRY_KEY)!;
    // 成员 u32Id = 下标+1;代理 u32Id = 1+N+序号(proxyList 序 = allDraws 遍历序)。
    const instancesA = Array.from({ length: memberCount }, (_, index) => ({
      transform: memberTransforms.subarray(index * 16, index * 16 + 16) as ArrayLike<number>,
      slot: memberSlot, u32Id: MEMBER_ID_BASE + index }));
    const renderInstancesA = ids.map((id, index) => ({ id, geometry: F2_MEMBER_GEOMETRY_KEY,
      material: F2_MATERIAL_ID, transform: memberTransforms.subarray(index * 16, index * 16 + 16) }));
    const allDraws = new Map(payload.proxyList.map(proxy => [proxy.drawId, {
      instanceId: proxy.drawId, geometryId: proxy.geometryId,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as number[] }]));
    const drawIdToU32 = new Map(payload.proxyList.map((proxy, ordinal) =>
      [proxy.drawId, proxyIdBase + ordinal] as const));
    const drawIdToOrdinal = new Map(payload.proxyList.map((proxy, ordinal) =>
      [proxy.drawId, ordinal] as const));

    const uniformsLayout = device.createBindGroupLayout({ label: "F2 uniforms layout", entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ] });
    const module = device.createShaderModule({ label: "F2 ID pass WGSL", code: ID_WGSL });
    const pipeline = device.createRenderPipeline({ label: "F2 ID pipeline",
      layout: device.createPipelineLayout({ label: "F2 layout", bindGroupLayouts: [uniformsLayout] }),
      vertex: { module, entryPoint: "vs", buffers: [{ arrayStride: 64, stepMode: "instance", attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x4" },
        { shaderLocation: 1, offset: 16, format: "float32x4" },
        { shaderLocation: 2, offset: 32, format: "float32x4" },
        { shaderLocation: 3, offset: 48, format: "uint32x4" }] }] },
      fragment: { module, entryPoint: "fs", targets: [{ format: "r32uint" }] },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" } });

    let farDepthA: GPUTexture | undefined;
    const cameraOutcomes: F2CameraOutcome[] = [];

    for (const camera of payload.cameras) {
      const hiddenIndices = Array.from(u32FromB64(camera.hiddenIndicesB64));
      const activeOrdinals = Array.from(u32FromB64(camera.activeProxyOrdinalsB64));
      const hiddenSet = new Set<number>(hiddenIndices);
      // 生产 applyHlodPlanToInstances 输入(HlodClusterFramePlan 最小构造,原点已 0)。
      const plan = {
        origin: [0, 0, 0] as readonly [number, number, number],
        hiddenInstanceIds: new Set<string>(hiddenIndices.map(index => ids[index]!)),
        activeProxyDraws: new Map<string, { readonly instanceId: string; readonly geometryId: string;
          readonly transform: readonly number[] }>(activeOrdinals.map(ordinal => {
          const draw = allDraws.get(payload.proxyList[ordinal]!.drawId);
          if (!draw) throw new Error(`active proxy ordinal ${ordinal} missing in allDraws.`);
          return [payload.proxyList[ordinal]!.drawId, draw];
        })),
        collapsedNodeCount: camera.collapsedNodeCount,
        suppressed: false,
      };
      const instancesBRender = applyHlodPlanToInstances(renderInstancesA, plan, allDraws, HLOD_PROXY_MATERIAL_ID);
      const rowsB = instancesBRender.map(instance => {
        const memberIndex = idToIndex.get(instance.id);
        const u32Id = memberIndex !== undefined ? MEMBER_ID_BASE + memberIndex : drawIdToU32.get(instance.id);
        if (u32Id === undefined) throw new Error(`state-B instance ${instance.id} has no u32 id mapping.`);
        const slot = instance.geometry === F2_MEMBER_GEOMETRY_KEY ? memberSlot
          : slots.get(instance.geometry);
        if (!slot) throw new Error(`state-B geometry ${instance.geometry} not in slots.`);
        return { transform: instance.transform, slot, u32Id };
      });
      const packedA = packInstanceRows(device, instancesA);
      const packedB = packInstanceRows(device, rowsB);

      const renderState = (packed: PackedInstances): { idTexture: GPUTexture; depthTexture: GPUTexture } => {
        const idTexture = device.createTexture({ label: "F2 ID attachment", size: [F2_VIEWPORT_WIDTH, F2_VIEWPORT_HEIGHT],
          format: "r32uint", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
        const depthTexture = device.createTexture({ label: "F2 depth attachment", size: [F2_VIEWPORT_WIDTH, F2_VIEWPORT_HEIGHT],
          format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
            | GPUTextureUsage.TEXTURE_BINDING });
        const uniformBuffer = device.createBuffer({ label: "F2 viewProj", size: 16 * 4,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(uniformBuffer, 0, viewProjectionMatrix(camera.eye, camera.forward,
          camera.tanHalfFovY, camera.near, camera.far));
        const bindGroup = device.createBindGroup({ layout: uniformsLayout, entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: { buffer: positionsBuffer } },
          { binding: 2, resource: { buffer: indicesBuffer } }] });
        const encoder = device.createCommandEncoder({ label: `F2 render` });
        const pass = encoder.beginRenderPass({ label: `F2 pass`, colorAttachments: [{
          view: idTexture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear",
          storeOp: "store" }], depthStencilAttachment: { view: depthTexture.createView(),
          depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.setVertexBuffer(0, packed.buffer);
        pass.draw(packed.maxIndexCount, packed.count);
        pass.end();
        device.queue.submit([encoder.finish()]);
        uniformBuffer.destroy();
        return { idTexture, depthTexture };
      };

      const stateA = renderState(packedA);
      const stateB = renderState(packedB);
      // 设备错误 fail-fast:渲染腿不允许带病产出空附件(上轮 WGSL 保留字教训)。
      if (deviceErrors.length > 0) {
        throw new Error(`F2 device errors during render: ${deviceErrors.slice(0, 3).join(" | ")}`);
      }
      if (camera.label === "远 4×") farDepthA = stateA.depthTexture;
      else stateA.depthTexture.destroy();

      const [idABytes, idBBytes] = await Promise.all([
        readbackAttachment(device, stateA.idTexture), readbackAttachment(device, stateB.idTexture)]);
      stateA.idTexture.destroy();
      stateB.idTexture.destroy();
      stateB.depthTexture.destroy();
      const idA = new Uint32Array(idABytes.buffer);
      const idB = new Uint32Array(idBBytes.buffer);
      if (idA.length !== PIXELS || idB.length !== PIXELS) {
        throw new Error(`readback size mismatch: ${idA.length}/${idB.length} != ${PIXELS}.`);
      }

      // 逐像素对比(冻结相机,两态同投影;门限见报告)。
      const bCoverMask = new Uint8Array(PIXELS);
      let aCovered = 0, bCovered = 0, bothBackground = 0, missRaw = 0, overhang = 0, agreePixels = 0;
      let memberAgreePixels = 0, proxyReplacedPixels = 0, proxyDifferentPixels = 0, hiddenViolationPixels = 0;
      let memberSwapPixels = 0;
      for (let index = 0; index < PIXELS; index++) {
        const a = idA[index]!, b = idB[index]!;
        if (b !== 0) bCoverMask[index] = 1;
        if (a === 0 && b === 0) { bothBackground += 1; continue; }
        if (a !== 0) aCovered += 1;
        if (b !== 0) bCovered += 1;
        if (a !== 0 && b === 0) { missRaw += 1; continue; }
        if (a === 0 && b !== 0) { overhang += 1; continue; }
        if (a === b) {
          agreePixels += 1;
          if (a <= memberCount) memberAgreePixels += 1;
          continue;
        }
        const bIsProxy = b > memberCount;
        const aIsProxy = a > memberCount;
        if (bIsProxy && !aIsProxy) proxyReplacedPixels += 1;
        else if (bIsProxy && aIsProxy) proxyDifferentPixels += 1;
        else if (hiddenSet.has(b - MEMBER_ID_BASE)) hiddenViolationPixels += 1;
        else memberSwapPixels += 1; // 双成员不同 id(非隐藏):A 的近层隐藏成员在 B 缩放后露出更远成员。
      }
      const bDilated = dilate(bCoverMask);
      let missTrue = 0;
      for (let index = 0; index < PIXELS; index++) {
        if (idA[index]! !== 0 && !bDilated[index]!) missTrue += 1;
      }
      cameraOutcomes.push({
        label: camera.label, instancesA: packedA.count, instancesB: packedB.count,
        degenerateB: packedB.degenerate, hiddenSet: hiddenIndices.length,
        activeProxies: activeOrdinals.length, aCovered, bCovered, bothBackground,
        missRaw, missTrue, overhang, agreePixels, memberAgreePixels, memberSwapPixels,
        proxyReplacedPixels, proxyDifferentPixels, hiddenViolationPixels,
        idShaA: await sha256Hex(idABytes), idShaB: await sha256Hex(idBBytes) });
      packedA.buffer.destroy();
      packedB.buffer.destroy();
    }

    // Hi-Z 帧内锚点:远档全量腿冻结深度 → 生产 HiZPyramid → 逐 mip 与生产 CPU 孪生对拍。
    if (!farDepthA) throw new Error("far depth texture missing for Hi-Z leg.");
    const depthBytes = await readbackAttachment(device, farDepthA);
    const depth = new Float32Array(depthBytes.buffer);
    const pyramid = new HiZPyramid(session);
    const encoder = device.createCommandEncoder({ label: "F2 Hi-Z" });
    const hiZ = pyramid.encode(encoder, { texture: farDepthA, revision: 1 }, { reversedZ: false });
    device.queue.submit([encoder.finish()]);
    for (let index = 0; index < 32; index++) await Promise.resolve();
    await device.queue.onSubmittedWorkDone();
    const cpuLevels = buildDepthPyramid(depth, F2_VIEWPORT_WIDTH, F2_VIEWPORT_HEIGHT, false);
    const levels: F2HiZLevelOutcome[] = [];
    for (const level of hiZ.levels) {
      const rowBytes = level.width * 4;
      const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
      const buffer = device.createBuffer({ label: `F2 hiz mip${level.level}`, size: bytesPerRow * level.height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const copyEncoder = device.createCommandEncoder({ label: `F2 hiz copy ${level.level}` });
      copyEncoder.copyTextureToBuffer({ texture: hiZ.texture, mipLevel: level.level },
        { buffer, bytesPerRow, rowsPerImage: level.height },
        { width: level.width, height: level.height, depthOrArrayLayers: 1 });
      device.queue.submit([copyEncoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      // 行距 256 对齐有填充:按行展开,不能用 width*4 连续索引(mip0 无填充除外)。
      const raw = new Uint8Array(buffer.getMappedRange().slice(0));
      buffer.unmap();
      buffer.destroy();
      const gpu = new Float32Array(level.width * level.height);
      for (let y = 0; y < level.height; y++) {
        gpu.set(new Float32Array(raw.buffer, y * bytesPerRow, level.width), y * level.width);
      }
      const twin = cpuLevels.levels[level.level]?.data;
      if (!twin || twin.length !== level.width * level.height) {
        throw new Error(`Hi-Z mip ${level.level}: CPU twin shape mismatch.`);
      }
      let maxAbsDiff = 0, bitwise = true;
      const mismatchSamples: { x: number; y: number; gpu: number; twin: number }[] = [];
      for (let index = 0; index < twin.length; index++) {
        if (gpu[index] !== twin[index]) {
          bitwise = false;
          const diff = Math.abs(gpu[index]! - twin[index]!);
          maxAbsDiff = Number.isFinite(diff) ? Math.max(maxAbsDiff, diff) : maxAbsDiff;
          if (mismatchSamples.length < 8) {
            mismatchSamples.push({ x: index % level.width, y: Math.floor(index / level.width),
              gpu: gpu[index]!, twin: twin[index]! });
          }
        }
      }
      levels.push({ level: level.level, width: level.width, height: level.height, maxAbsDiff, bitwise,
        ...(mismatchSamples.length ? { mismatchSamples } : {}) });
    }
    const hiZOutcome: F2HiZOutcome = { label: "远 4× 全量腿冻结深度", pyramidMipLevelCount: hiZ.mipLevelCount,
      reduction: hiZ.reduction, levels,
      gpuMip0MatchesDepthReadback: levels[0] !== undefined && levels[0]!.bitwise };
    pyramid.dispose();
    farDepthA.destroy();
    positionsBuffer.destroy();
    indicesBuffer.destroy();

    return {
      adapter, browserVersion, userAgent, deviceErrors, cameras: cameraOutcomes, hiZ: hiZOutcome,
      draws: { stateA: 1, stateB: 1,
        note: "probe 两态各 1 个实例化 draw(对象 ID 自持 pass);生产 draw 账目见逐相机 t26(计划层,与 batchBench 同源)。"
          + "真机佐证:折叠腿隐藏成员 1e-6 缩放实例零像素(hiddenViolationPixels=0 门限)。" },
    };
  } finally {
    session.dispose();
  }
}
