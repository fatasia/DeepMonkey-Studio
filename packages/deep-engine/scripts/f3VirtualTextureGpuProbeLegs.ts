// F3/T06 虚拟纹理 probe 证据腿(sourceSizeGate 拆分:自 f3VirtualTextureGpuProbe.ts
// 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:a. SSIM≥0.99 / b. 相机 A→B→A 往返 / c. 预算恢复 / d. 取消泄漏 四条证据腿。
import { DeviceSession } from "../src/webgpu/deviceSession.js";
import { VirtualTextureTileLookupPass } from "../src/webgpu/virtualTextureSampling.js";
import { createSyntheticRgba8 } from "../src/virtualTextures/virtualTexturePages.js";
import { TEXTURE_ID, TEXTURE_SIZE, TILE_EDGE, GRID, PAGE_BYTES,
  makeBridge, tileEntries, fullCoverageEntries, tileSet, pageDefined, committedResidentPages,
  driveToSettled, settleDevice, tileCenterSamples } from "./f3VirtualTextureGpuProbeSession.js";
import { captureViaTileLookup, captureViaReference, fullImageSamples } from "./f3VirtualTextureGpuProbeReadback.js";
import { computeSsim, diffStats, imageRange, metricsTail, evictionsDuring,
  residentBytesWithinBudget } from "./f3VirtualTextureGpuProbeMetrics.js";

// ────────────────────────── a. SSIM ≥ 0.99 ──────────────────────────

export async function legSsim(session: DeviceSession, adapter: unknown, deviceErrors: string[]): Promise<Record<string, unknown>> {
  const width = 1920, height = 1080;
  const texture = createSyntheticRgba8(TEXTURE_ID, TEXTURE_SIZE, TEXTURE_SIZE, 7);
  const budgetBytes = 8 * 1024 * 1024; // 128 层,全 64 个 mip0 页 + 余量
  const bridge = makeBridge(session, budgetBytes, 32);
  bridge.syncTextures([texture]);
  const drive = await driveToSettled(session, bridge, fullCoverageEntries(), tileSet(0, GRID));
  if (!drive.settled) throw new Error(`SSIM leg: pages did not settle (${JSON.stringify(metricsTail(drive.frames))})`);
  const samples = fullImageSamples(width, height);
  const packing = bridge.packPageTable();
  const atlasView = bridge.atlasTexture!.createView({ dimension: "2d-array" });
  const vt = await captureViaTileLookup(session, {
    catalog: bridge.textureCatalog(), layerOfPage: (id, tx, ty, mip) => bridge.layerOfPage(id, tx, ty, mip),
    packing: packing.data, atlasEdge: bridge.atlasEdgeTexels, atlasView }, samples);
  const reference = await captureViaReference(session, texture, samples);
  const ssim = computeSsim(vt, reference, width, height);
  const diff = diffStats(vt, reference, width);
  // 生产消费 pass 冒烟:同一 encoder 上以生产 pass 编码一批 64 样本(合同 dispatch/无 skip)。
  const lookup = new VirtualTextureTileLookupPass(session);
  const encoder = session.device.createCommandEncoder({ label: "F3 VT production pass smoke" });
  const smoke = lookup.encode(encoder, { atlasView, atlasEdge: bridge.atlasEdgeTexels,
    catalog: bridge.textureCatalog(), layerOfPage: (id, tx, ty, mip) => bridge.layerOfPage(id, tx, ty, mip),
    packing: packing.data, samples: tileCenterSamples(tileSet(0, 8)) });
  session.device.queue.submit([encoder.finish()]);
  await session.device.queue.onSubmittedWorkDone();
  lookup.dispose();
  const residentPages = committedResidentPages(bridge);
  bridge.dispose();
  const vtRange = imageRange(vt), referenceRange = imageRange(reference);
  const pass = ssim.mean >= 0.99 && diff.magentaCount === 0
    && smoke.dispatches === 1 && smoke.skipped === undefined
    && deviceErrors.length === 0 && !vtRange.constant && !referenceRange.constant;
  return {
    method: "虚拟纹理路径=bridge.observeFrame→atlas驻留→packPageTable+生产tile-lookup WGSL读回;基线=同一DecodedTexture整纹理线性clamp采样;SSIM=8×8块C1/C2标准口径;生产pass冒烟并行记录",
    size: { width, height }, sampleCount: samples.length,
    texture: { id: TEXTURE_ID, width: TEXTURE_SIZE, height: TEXTURE_SIZE, tileEdge: TILE_EDGE,
      grid: GRID, budgetBytes },
    residency: { ...metricsTail(drive.frames), committedMip0Pages: residentPages.length,
      residentBytesWithinBudget: residentBytesWithinBudget(drive.frames, budgetBytes) },
    ssim: { ...ssim, threshold: 0.99 },
    diff, vtRange, referenceRange,
    productionPassSmoke: smoke,
    adapter, deviceErrors,
    pass,
  };
}

// ────────────────────────── b. 相机 A→B→A 往返 ──────────────────────────

export async function legCameraRoundTrip(session: DeviceSession, adapter: unknown, deviceErrors: string[]): Promise<Record<string, unknown>> {
  const texture = createSyntheticRgba8(TEXTURE_ID, TEXTURE_SIZE, TEXTURE_SIZE, 11);
  const budgetBytes = 36 * PAGE_BYTES; // 36 层 = |A|:A 恰满预算,B 回 A 须逐出全部 B 独有页
  const poseA = tileSet(0, 6);   // 左上 6×6(近观)
  const poseB = tileSet(1, 7);   // 右下移位 6×6(远观);A∩B=5×5=25,A∪B=47>36 → 真实压力
  const bridge = makeBridge(session, budgetBytes, 16);
  bridge.syncTextures([texture]);
  const entriesA = tileEntries(poseA);
  const entriesB = tileEntries(poseB);

  const a0 = await driveToSettled(session, bridge, entriesA, poseA);
  if (!a0.settled) throw new Error("round trip: pose A initial did not settle");
  const pagesA0 = committedResidentPages(bridge);
  const outA0 = await captureViaTileLookup(session, {
    catalog: bridge.textureCatalog(), layerOfPage: (id, tx, ty, mip) => bridge.layerOfPage(id, tx, ty, mip),
    packing: bridge.packPageTable().data, atlasEdge: bridge.atlasEdgeTexels,
    atlasView: bridge.atlasTexture!.createView({ dimension: "2d-array" }) }, tileCenterSamples(poseA));

  const b = await driveToSettled(session, bridge, entriesB, poseB);
  if (!b.settled) throw new Error("round trip: pose B did not settle");
  const pagesB = committedResidentPages(bridge);
  const evictionsBeforeB = a0.frames[a0.frames.length - 1]!.evictions;
  const evictionsAfterB = evictionsDuring(b.frames, evictionsBeforeB);

  const a1 = await driveToSettled(session, bridge, entriesA, poseA);
  if (!a1.settled) throw new Error("round trip: pose A return did not settle");
  const pagesA1 = committedResidentPages(bridge);
  const outA1 = await captureViaTileLookup(session, {
    catalog: bridge.textureCatalog(), layerOfPage: (id, tx, ty, mip) => bridge.layerOfPage(id, tx, ty, mip),
    packing: bridge.packPageTable().data, atlasEdge: bridge.atlasEdgeTexels,
    atlasView: bridge.atlasTexture!.createView({ dimension: "2d-array" }) }, tileCenterSamples(poseA));

  let outputBitwiseEqual = outA0.length === outA1.length;
  let outputMaxAbsDiff = 0;
  for (let index = 0; index < outA0.length && outputBitwiseEqual; index++) {
    if (outA0[index] !== outA1[index]) outputBitwiseEqual = false;
    outputMaxAbsDiff = Math.max(outputMaxAbsDiff, Math.abs(outA0[index]! - outA1[index]!));
  }
  const residentSetIdentical = pagesA0.length === pagesA1.length
    && pagesA0.every((id, index) => id === pagesA1[index]);
  const budgetHeld = residentBytesWithinBudget([...a0.frames, ...b.frames, ...a1.frames], budgetBytes);
  bridge.dispose();
  const overlap = pagesA0.filter(id => pagesB.includes(id)).length;
  const outputRange = imageRange(outA0);
  const pass = residentSetIdentical && outputBitwiseEqual && budgetHeld
    && evictionsAfterB > 0 && overlap === 25
    && deviceErrors.length === 0 && !outputRange.constant;
  return {
    method: "相机代理=可见tile集×screenPixels(A=左上6×6近观,B=移位6×6远观;A恰满预算36,并集47>36 → B挤出11页A独有,回A须逐出11页B独有);生产链=反馈读取器→页表plan→驻留commit→layerOfPage→打包→tile-lookup读回",
    budgetBytes,
    poseA: { tiles: poseA.length, entries: entriesA.length },
    poseB: { tiles: poseB.length, entries: entriesB.length },
    phaseA0: { ...metricsTail(a0.frames), residentPageCount: pagesA0.length },
    phaseB: { ...metricsTail(b.frames), residentPageCount: pagesB.length, overlapWithA: overlap },
    phaseA1: { ...metricsTail(a1.frames), residentPageCount: pagesA1.length },
    residentSetIdentical, outputBitwiseEqual, outputMaxAbsDiff, budgetHeld, outputRange,
    adapter, deviceErrors,
    pass,
  };
}

// ────────────────────────── c. 预算恢复 ──────────────────────────

export async function legBudgetRecovery(session: DeviceSession, adapter: unknown, deviceErrors: string[]): Promise<Record<string, unknown>> {
  const texture = createSyntheticRgba8(TEXTURE_ID, TEXTURE_SIZE, TEXTURE_SIZE, 13);
  const budgetBytes = 16 * PAGE_BYTES; // 16 层:S1/S2 各恰满预算,全 64 tile ≫ 预算
  const baseline = tileSet(0, 4);      // S1: 左上 4×4 = 16 tile
  const pressure = tileSet(0, GRID);   // 全 64 tile ≫ 预算
  const squeeze = tileSet(4, 8);       // S2: 右下 4×4 = 16 tile,与 S1 不相交
  const bridge = makeBridge(session, budgetBytes, 8);
  bridge.syncTextures([texture]);

  const stage0 = await driveToSettled(session, bridge, tileEntries(baseline), baseline);
  if (!stage0.settled) throw new Error("budget: baseline did not settle");
  const baselinePages = committedResidentPages(bridge);

  const stage1 = await driveToSettled(session, bridge, tileEntries(pressure));
  const pagesAfterPressure = committedResidentPages(bridge);
  const evictionsAfterPressure = stage1.frames[stage1.frames.length - 1]!.evictions;

  const stage2 = await driveToSettled(session, bridge, tileEntries(squeeze), squeeze);
  if (!stage2.settled) throw new Error("budget: squeeze did not settle");
  const evictionsAfterSqueeze = evictionsDuring(stage2.frames, evictionsAfterPressure);
  const pagesAfterSqueeze = committedResidentPages(bridge);

  const stage3 = await driveToSettled(session, bridge, tileEntries(baseline), baseline);
  if (!stage3.settled) throw new Error("budget: recovery did not settle");
  const recoveredPages = committedResidentPages(bridge);
  const recoveredSetIdentical = baselinePages.length === recoveredPages.length
    && baselinePages.every((id, index) => id === recoveredPages[index]);
  const samplingRestored = baseline.every(([tileX, tileY]) => pageDefined(bridge, tileX, tileY, 0));
  const outRecovered = await captureViaTileLookup(session, {
    catalog: bridge.textureCatalog(), layerOfPage: (id, tx, ty, mip) => bridge.layerOfPage(id, tx, ty, mip),
    packing: bridge.packPageTable().data, atlasEdge: bridge.atlasEdgeTexels,
    atlasView: bridge.atlasTexture!.createView({ dimension: "2d-array" }) }, tileCenterSamples(baseline));
  const outReferenceRun = await captureViaTileLookup(session, {
    catalog: bridge.textureCatalog(), layerOfPage: (id, tx, ty, mip) => bridge.layerOfPage(id, tx, ty, mip),
    packing: bridge.packPageTable().data, atlasEdge: bridge.atlasEdgeTexels,
    atlasView: bridge.atlasTexture!.createView({ dimension: "2d-array" }) }, tileCenterSamples(baseline));
  let recoveredOutputStable = outRecovered.length === outReferenceRun.length;
  for (let index = 0; index < outRecovered.length && recoveredOutputStable; index++)
    recoveredOutputStable = outRecovered[index] === outReferenceRun[index];
  const budgetHeldEveryFrame = residentBytesWithinBudget(
    [...stage0.frames, ...stage1.frames, ...stage2.frames, ...stage3.frames], budgetBytes);
  bridge.dispose();
  const overPressureWithinBudget = pagesAfterPressure.length <= 16;
  const squeezeDisplaced = pagesAfterSqueeze.length === 16 && pagesAfterSqueeze.every(id =>
    squeeze.some(([tileX, tileY]) => id.endsWith(`|${tileX},${tileY}|mip0`)));
  const recoveredRange = imageRange(outRecovered);
  const pass = stage0.settled && stage2.settled && stage3.settled
    && evictionsAfterSqueeze > 0
    && overPressureWithinBudget && squeezeDisplaced
    && recoveredSetIdentical && samplingRestored && recoveredOutputStable && budgetHeldEveryFrame
    && deviceErrors.length === 0 && !recoveredRange.constant;
  return {
    method: "预算16层;S1=左上4×4(基线服务)→全64tile超压(defer52/准入16)→S2=右下4×4(逐出S1全部16页=回收)→解除回S1(页集恢复+采样恢复+输出稳定)",
    budgetBytes,
    stage0Baseline: { ...metricsTail(stage0.frames), residentPageCount: baselinePages.length },
    stage1OverPressure: { ...metricsTail(stage1.frames), residentPageCount: pagesAfterPressure.length,
      overPressureWithinBudget, evictionsAfterPressure },
    stage2Squeeze: { ...metricsTail(stage2.frames), residentPageCount: pagesAfterSqueeze.length,
      squeezeDisplaced, evictionsAfterSqueeze },
    stage3Recovered: { ...metricsTail(stage3.frames), residentPageCount: recoveredPages.length },
    recoveredSetIdentical, samplingRestored, recoveredOutputStable, budgetHeldEveryFrame, recoveredRange,
    adapter, deviceErrors,
    pass,
  };
}

// ────────────────────────── d. 取消泄漏 ──────────────────────────

export async function legCancellationLeak(session: DeviceSession, adapter: unknown, deviceErrors: string[]): Promise<Record<string, unknown>> {
  const texture = createSyntheticRgba8(TEXTURE_ID, TEXTURE_SIZE, TEXTURE_SIZE, 17);
  const budgetBytes = 32 * PAGE_BYTES;
  const memorySnapshot = (): Record<string, unknown> => {
    const snapshot = session.resourceMemory;
    return { bufferBytes: snapshot.bufferBytes, textureBytes: snapshot.textureBytes,
      estimatedBytes: snapshot.estimatedBytes, resourceCount: snapshot.resourceCount,
      unknownResources: snapshot.unknownResources };
  };

  // 路径 1:releaseTexture 中途取消(批次 in-flight 时排队页回滚 + 收口后整纹理逐出)。
  const bridge1 = makeBridge(session, budgetBytes, 4);
  bridge1.syncTextures([texture]);
  const frame1 = bridge1.observeFrame(fullCoverageEntries());
  // 无泄漏恒等式:取消时点的页总额(已入批 uploadsQueued + 仍排队 uploadBacklog)
  // == 收口后终态(uploadsCommitted + uploadsRolledBack);uploadsQueued 只计进入
  // writeBatch 的页,排队排空不经它,故对账要含 backlog。
  const pagesAtCancel = frame1.uploadsQueued + frame1.uploadBacklog;
  const inflightQueued = frame1.uploadBacklog;
  bridge1.releaseTexture(TEXTURE_ID);
  await settleDevice(session);
  const frame1After = bridge1.observeFrame([]);
  const packing1 = bridge1.packPageTable().data;
  const layersAllFree1 = [...packing1.pageLayers].every(layer => layer === -1);
  const accountingHolds1 = frame1After.uploadsCommitted + frame1After.uploadsRolledBack
    === pagesAtCancel;
  const leakFree1 = frame1After.uploadBacklog === 0 && frame1After.residentPages === 0
    && layersAllFree1 && accountingHolds1 && frame1After.evictions > 0;
  bridge1.dispose();

  // 路径 2:bridge.dispose 中途取消(批次收口走 disposed 分支回滚)。
  const bridge2 = makeBridge(session, budgetBytes, 4);
  bridge2.syncTextures([texture]);
  bridge2.observeFrame(fullCoverageEntries());
  const midFlight = { atlasCreated: bridge2.atlasTexture !== undefined,
    backlog: bridge2.metrics?.uploadBacklog ?? -1 };
  bridge2.dispose();
  await settleDevice(session);
  let disposeThrows = false, packThrows = false;
  try { bridge2.observeFrame([]); } catch { disposeThrows = true; }
  try { bridge2.packPageTable(); } catch { packThrows = true; }
  const atlasReleasedAfterBridgeDispose = bridge2.atlasTexture === undefined;
  const memoryAfterBridgeDispose = memorySnapshot();
  session.dispose();
  const memoryAfterSessionDispose = memorySnapshot();
  const allZero = memoryAfterSessionDispose.resourceCount === 0
    && memoryAfterSessionDispose.textureBytes === 0 && memoryAfterSessionDispose.bufferBytes === 0;
  const pass = leakFree1 && disposeThrows && packThrows
    && atlasReleasedAfterBridgeDispose && allZero && deviceErrors.length === 0;
  return {
    method: "路径1=releaseTexture中途取消(排队回滚+收口后整纹理逐出);路径2=bridge.dispose中途取消(settleBatch disposed分支回滚);资源计数=引擎遥测(queued=committed+rolledBack,backlog0,resident0,pageLayers全-1)+session resourceMemory 归零",
    budgetBytes,
    path1: { pagesAtCancel, inflightQueued, after: { uploadBacklog: frame1After.uploadBacklog,
      residentPages: frame1After.residentPages, uploadsQueued: frame1After.uploadsQueued,
      uploadsCommitted: frame1After.uploadsCommitted, uploadsRolledBack: frame1After.uploadsRolledBack,
      evictions: frame1After.evictions }, layersAllFree: layersAllFree1,
      accountingHolds: accountingHolds1, leakFree: leakFree1 },
    path2: { midFlight, disposeThrows, packThrows, atlasReleasedAfterBridgeDispose,
      memoryAfterBridgeDispose, memoryAfterSessionDispose, allZero },
    deviceErrors,
    adapter,
    pass,
  };
}
