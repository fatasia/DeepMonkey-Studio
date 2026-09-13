import { DeviceSession } from "./deviceSession.js";
import { MeshBuffers, uploadBuffer } from "./meshBuffers.js";
import { createPipelines, PBR_FRAME_UNIFORM_FLOATS, type Pipelines } from "./pipelines.js";
import { groundMesh } from "./primitives.js";
import { PBR_HDR_FORMAT, RenderTargets } from "./renderTargets.js";
import type { StudioEnvironment } from "./studioEnvironment.js";
import { GpuTimer } from "./gpuTimer.js";
import { PacketBuffers } from "./packetBuffers.js";
import type { InstanceUpdate, RenderPacket } from "../renderPacket.js";
import { spherePacket } from "./spherePacket.js";
import { CameraFrameHistory } from "./cameraFrameHistory.js";
import { PbrPostProcessChain, type PbrPostProcessInput } from "./pbrPostProcessChain.js";
import { WeightedOitPass } from "./weightedOit.js";
import { cameraFrustum, viewProjectionFrustum } from "./pbrFrusta.js";
import { ForwardPlusPbrRuntime } from "../lighting/forwardPlusPbrRuntime.js";
import { transformWorldLightsToView } from "../lighting/worldLights.js";
import { updatePbrFrameUniforms } from "./pbrFrameUniforms.js";
import { PreviousHiZVisibility, type PreviousHiZFramePlan } from "./previousHiZVisibility.js";
import { CascadedShadowResources } from "./cascadedShadowResources.js";
import { resolvePbrSceneLighting } from "../lighting/pbrSceneLighting.js";
import type { FrameMetrics, PbrRendererOptions, RenderView } from "./pbrRendererTypes.js";
import type { ResidentPacketProjection } from "./residentPacketProjection.js";
import { resolvePbrRendererFeatures, type PbrRendererFeatures } from "./pbrRendererFeatures.js";
import { createPbrEnvironment, type PbrEnvironmentSource } from "./pbrEnvironmentSource.js";
import { PbrEnvironmentState, type EnvironmentStageResult } from "./pbrEnvironmentState.js";
import { createPbrMainBindings } from "./pbrMainBindings.js";
import { PbrOutputBindings } from "./pbrOutputBindings.js";
export type { FrameMetrics, PbrRendererOptions, RenderView } from "./pbrRendererTypes.js";
export class PbrRenderer {
  readonly id = "deep-webgpu";
  readonly gpuTimer: GpuTimer;
  private readonly packets: PacketBuffers;
  private readonly ground: MeshBuffers;
  private readonly frameBuffer: GPUBuffer;
  private readonly outputBuffer: GPUBuffer;
  private readonly groundInstance: GPUBuffer;
  private mainBindings: GPUBindGroup;
  private readonly environment: PbrEnvironmentState;
  private readonly shadows: CascadedShadowResources;
  private readonly targets: RenderTargets;
  private readonly postProcess: PbrPostProcessChain;
  private readonly transparency: WeightedOitPass;
  private readonly lighting: ForwardPlusPbrRuntime;
  private readonly cameraHistory = new CameraFrameHistory();
  private readonly previousHiZ = new PreviousHiZVisibility();
  private pendingHiZ: PreviousHiZFramePlan | undefined;
  private readonly outputs: PbrOutputBindings;
  private readonly features: PbrRendererFeatures;
  private frame = 0;
  private shadowDirty = true;
  private historyDirty = true;
  private readonly frameData = new Float32Array(PBR_FRAME_UNIFORM_FLOATS);
  private readonly outputData = new Float32Array([1, 0, 0.25, 0]);
  private readonly groundData = new Float32Array(36);
  private constructor(readonly session: DeviceSession, private readonly pipelines: Pipelines,
    environment: StudioEnvironment, lighting: ForwardPlusPbrRuntime, options: PbrRendererOptions) {
    const device = session.device;
    this.gpuTimer = new GpuTimer(session);
    this.packets = new PacketBuffers(session, pipelines.materialLayout);
    this.ground = new MeshBuffers(session, groundMesh());
    this.frameBuffer = uploadBuffer(session, "Deep frame", this.frameData, GPUBufferUsage.UNIFORM);
    this.outputBuffer = uploadBuffer(session, "Deep output", this.outputData, GPUBufferUsage.UNIFORM);
    this.groundInstance = uploadBuffer(session, "Deep ground", this.groundData, GPUBufferUsage.VERTEX);
    this.shadows = new CascadedShadowResources(session, pipelines, options.shadows);
    this.environment = new PbrEnvironmentState(environment);
    this.mainBindings = createPbrMainBindings(device, pipelines, this.frameBuffer, this.shadows, environment);
    this.targets = new RenderTargets(session, pipelines.output.getBindGroupLayout(0), this.outputBuffer);
    this.features = resolvePbrRendererFeatures(options.features);
    this.postProcess = new PbrPostProcessChain(session, this.features);
    this.transparency = new WeightedOitPass(session);
    this.lighting = lighting;
    this.outputs = new PbrOutputBindings(device, pipelines, this.outputBuffer);
  }
  static async create(canvas: HTMLCanvasElement, gpu: GPU | undefined, signal: AbortSignal, options: PbrRendererOptions = {}): Promise<PbrRenderer> {
    const session = await DeviceSession.open(canvas, gpu, signal);
    const cancel = (): void => session.dispose();
    let scopeOpen = false;
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) throw new DOMException("GPU preparation cancelled", "AbortError");
      session.device.pushErrorScope("validation"); scopeOpen = true;
      const lighting = new ForwardPlusPbrRuntime(session);
      const [pipelines, environment] = await Promise.all([
        createPipelines(session.device, session.format, lighting.layout),
        createPbrEnvironment(session, options.environment, signal),
      ]);
      if (signal.aborted || session.state !== "ready") throw new Error("GPU preparation interrupted.");
      const renderer = new PbrRenderer(session, pipelines, environment, lighting, options);
      const pendingError = session.device.popErrorScope(); scopeOpen = false;
      const error = await pendingError;
      if (error) throw new Error(error.message);
      if (signal.aborted || session.state !== "ready") throw new Error("GPU preparation interrupted.");
      return renderer;
    } catch (error) {
      if (scopeOpen) try { await session.device.popErrorScope(); } catch { /* device loss owns diagnostics */ }
      session.dispose(); throw error;
    }
    finally { signal.removeEventListener("abort", cancel); }
  }
  setInstances(data: Float32Array<ArrayBuffer>): void { this.setPacket(spherePacket(data)); }
  setPacket(packet: RenderPacket): void { if (this.packets.set(packet)) this.sceneChanged(); }
  async setPacketValidated(packet: RenderPacket, signal?: AbortSignal): Promise<void> {
    if (await this.packets.setValidated(packet, signal)) this.sceneChanged();
  }
  /** Publishes this complete resident projection immediately before the next frame is encoded. */
  stageResidentPacket(projection: ResidentPacketProjection): void {
    this.packets.stageResidentProjection(projection);
  }
  async stageResidentPacketValidated(projection: ResidentPacketProjection,
    signal?: AbortSignal): Promise<void> {
    await this.packets.stageResidentProjectionValidated(projection, signal);
  }
  cancelResidentPacketStage(): void { this.packets.cancelPendingPacketStage(); }
  async setInstancesValidated(data: Float32Array<ArrayBuffer>, signal?: AbortSignal): Promise<void> {
    await this.setPacketValidated(spherePacket(data), signal);
  }
  updateInstances(update: InstanceUpdate): void {
    if (this.packets.updateInstances(update)) this.shadowDirty = true;
  }
  stageEnvironment(source: PbrEnvironmentSource, signal?: AbortSignal): Promise<EnvironmentStageResult> {
    return this.environment.stage(candidateSignal => createPbrEnvironment(this.session, source, candidateSignal), signal);
  }
  render(view: RenderView): FrameMetrics | undefined {
    const begin = performance.now();
    if (this.session.state !== "ready") return undefined;
    if (this.session.hasErrors) throw new Error("GPU validation failed; inspect device diagnostics.");
    this.validateView(view);
    this.environment.publish(candidate => { this.mainBindings = createPbrMainBindings(this.session.device,
      this.pipelines, this.frameBuffer, this.shadows, candidate); });
    const sceneLighting = resolvePbrSceneLighting(view.lights);
    if (this.pendingHiZ) { this.previousHiZ.failFrame(this.pendingHiZ); this.pendingHiZ = undefined; }
    this.packets.failLodFrame();
    this.cameraHistory.cancelPendingFrame();
    try {
      if (this.packets.publishResidentProjection()) this.sceneChanged();
    } catch (error) {
      this.sceneChanged(); throw error;
    }
    const size = this.session.resize(view.width, view.height, view.pixelRatio);
    if (!size) return undefined;
    this.targets.resize(size);
    const frameState = updatePbrFrameUniforms(this.session.device.queue, this.cameraHistory, view,
      size.width, size.height, this.historyDirty, { frameBuffer: this.frameBuffer, outputBuffer: this.outputBuffer,
        groundInstance: this.groundInstance, frameData: this.frameData, outputData: this.outputData, groundData: this.groundData },
      sceneLighting.primary, this.features);
    const history = frameState.history;
    const hiZPlan = this.previousHiZ.beginFrame({ frameRevision: history.revision,
      sceneRevision: this.packets.visibilityRevision, depthViewProjection: frameState.depthViewProjection,
      stableViewProjection: frameState.stableViewProjection, cameraPosition: view.eye,
      viewport: [size.width, size.height], reversedZ: false, cameraCut: history.cameraCut });
    this.pendingHiZ = hiZPlan;
    const device = this.session.device;
    const encoder = device.createCommandEncoder({ label: "Deep frame" });
    const mainFrustum = cameraFrustum(view.eye, view.target, view.up,
      size.width / size.height, frameState.projection);
    let submitAttempted = false;
    try {
    const lodStats = this.packets.encodeLod(encoder, { camera: { projection: "perspective", position: view.eye,
      forward: [view.target[0] - view.eye[0], view.target[1] - view.eye[1], view.target[2] - view.eye[2]],
      verticalFovRadians: frameState.projection.verticalFovRadians, near: frameState.projection.near,
      far: frameState.projection.far }, viewport: { width: size.width, height: size.height }, frustum: mainFrustum,
      ...(view.lodBudget ? { budget: view.lodBudget } : {}), cameraJump: history.cameraCut });
    const lighting = this.lighting.prepareAndEncode(encoder, { viewportWidth: size.width, viewportHeight: size.height,
      near: frameState.projection.near, far: frameState.projection.far,
      verticalFovRadians: frameState.projection.verticalFovRadians,
      lights: transformWorldLightsToView(sceneLighting.clustered, frameState.worldToView) });
    const timing = this.gpuTimer.begin(this.frame + 1);
    const timingStart = timing ? { timestampWrites: { querySet: timing.queries, beginningOfPassWriteIndex: 0 } } : {};
    const shadowFrame = this.shadows.prepare({ eye: view.eye, target: view.target, ...(view.up ? { up: view.up } : {}),
      verticalFovRadians: frameState.projection.verticalFovRadians, aspect: size.width / size.height,
      near: frameState.projection.near, far: frameState.projection.far, extent: view.extent,
      lightDirection: sceneLighting.primary.rayDirectionWorld }, this.shadowDirty);
    const shadowUpdated = shadowFrame.render;
    let drawCalls = 2, triangles = 3;
    if (shadowUpdated) {
      this.packets.encodeShadowLod(encoder, shadowFrame.plan);
      shadowFrame.plan.cascades.forEach((cascade, index) => {
        this.packets.encodeCulling(encoder, viewProjectionFrustum(cascade.viewProjection), "shadow", undefined, index);
        const shadow = encoder.beginRenderPass({ label: `Deep shadow cascade ${index}`,
          ...(index === 0 ? timingStart : {}), colorAttachments: [], depthStencilAttachment: {
            view: this.shadows.layerViews[index]!, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store",
          } });
        shadow.setPipeline(this.pipelines.shadow);
        shadow.setBindGroup(0, this.shadows.frameBindings[index]!);
        const stats = this.packets.draw(shadow, this.pipelines, "shadow", undefined, true, index);
        drawCalls += stats.drawCalls; triangles += stats.triangles;
        shadow.end();
      });
    }
    const previousHiZ = this.previousHiZ.occlusionView(hiZPlan);
    const opaqueCulling = this.packets.encodeCulling(encoder, mainFrustum, "opaque",
      { sceneRevision: this.packets.visibilityRevision, ...(previousHiZ ? { previousHiZ } : {}) });
    const hasTransparent = this.packets.hasTransparent();
    const main = encoder.beginRenderPass({ label: "Deep HDR opaque MRT", ...(!shadowUpdated ? timingStart : {}), colorAttachments: [
      { view: this.targets.hdr, clearValue: [...view.background, 1], loadOp: "clear", storeOp: "store" },
      { view: this.targets.linearDepth, clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" },
      { view: this.targets.normal, clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" },
      { view: this.targets.motion, clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" },
    ], depthStencilAttachment: { view: this.targets.depth, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
    main.setPipeline(this.pipelines.main);
    main.setBindGroup(0, this.mainBindings);
    main.setBindGroup(2, this.shadows.binding);
    main.setBindGroup(lighting.bindGroupIndex, lighting.bindGroup);
    const stats = this.packets.draw(main, this.pipelines, "opaque", undefined, true);
    drawCalls += stats.drawCalls; triangles += stats.triangles;
    main.setPipeline(this.pipelines.main);
    // Static ground has zero object motion; camera motion comes from the previous view-projection.
    this.ground.draw(main, this.groundInstance, 1, false, this.groundInstance);
    main.end();
    const postProcessInput: PbrPostProcessInput = { encoder, targets: this.targets, revision: history.revision,
      extent: view.extent, verticalFovRadians: frameState.projection.verticalFovRadians,
      cameraCut: history.cameraCut, currentJitter: history.currentJitter,
      previousJitter: history.previousJitter };
    const opaqueEffects = this.postProcess.encodeOpaque(postProcessInput);
    let temporalInput = opaqueEffects.color;
    if (hasTransparent) {
      this.transparency.resize(size.width, size.height);
      const transparent = encoder.beginRenderPass({ label: "Deep weighted OIT accumulation",
        colorAttachments: this.transparency.accumulationAttachments(),
        depthStencilAttachment: { view: this.targets.depth, depthLoadOp: "load", depthStoreOp: "discard" } });
      transparent.setBindGroup(0, this.mainBindings);
      transparent.setBindGroup(2, this.shadows.binding);
      transparent.setBindGroup(lighting.bindGroupIndex, lighting.bindGroup);
      const transparentStats = this.packets.draw(transparent, this.pipelines, "transparent", undefined, true);
      drawCalls += transparentStats.drawCalls; triangles += transparentStats.triangles;
      transparent.end();
      this.transparency.encodeComposite(encoder, this.outputs.view(opaqueEffects.color), this.targets.hdr,
        { outputFormat: PBR_HDR_FORMAT });
      temporalInput = this.targets.hdrTexture; drawCalls++;
    }
    const finalEffects = this.postProcess.encodeFinal(postProcessInput, temporalInput);
    const output = encoder.beginRenderPass({ label: "Deep display output", ...(timing ? { timestampWrites: { querySet: timing.queries, endOfPassWriteIndex: 1 } } : {}), colorAttachments: [{ view: this.session.context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store" }] });
    output.setPipeline(this.pipelines.output);
    output.setBindGroup(0, this.outputs.binding(finalEffects.color));
    output.draw(3);
    output.end();
    timing?.resolve(encoder);
    const commands = encoder.finish();
    submitAttempted = true; device.queue.submit([commands]);
    this.packets.commitLodFrame();
    this.shadows.commit();
    this.cameraHistory.commitFrame(history);
    this.previousHiZ.commitFrame(hiZPlan, opaqueEffects.hiZ); this.pendingHiZ = undefined;
    this.packets.commitFrame();
    timing?.read();
    this.shadowDirty = false; this.historyDirty = false;
    return { frame: ++this.frame, cpuSubmitMs: performance.now() - begin, drawCalls, triangles,
      width: size.width, height: size.height, resources: this.session.resourceCount, shadowUpdated,
      cameraCut: history.cameraCut, postProcessPasses: opaqueEffects.passCount + finalEffects.passCount + (hasTransparent ? 2 : 0),
      weightedOit: hasTransparent,
      hiZMipLevels: opaqueEffects.hiZ.mipLevelCount,
      occlusionCulling: opaqueCulling.occlusionBatches > 0,
      frustumCulledBatches: opaqueCulling.frustumBatches, hiZOccludedBatches: opaqueCulling.occlusionBatches, lodSelectionBatches: lodStats.selectionBatches, lodIndirectDraws: lodStats.indirectDraws,
      lightCount: lighting.lightCount, lightClusters: lighting.grid.clusterCount,
      shadowTier: this.shadows.selection.selectedTier, shadowDepthBytes: this.shadows.selection.profile.estimatedDepthTextureBytes };
    } catch (error) {
      if (submitAttempted) this.packets.failLodFrame(); else this.packets.cancelLodFrame();
      throw error;
    }
  }
  /** 首帧门禁需等待真实 GPU 提交完成；普通帧不插入 CPU/GPU 同步栅栏。 */
  async validateFrame(view: RenderView): Promise<FrameMetrics> {
    if (this.session.state !== "ready") throw new Error("Renderer is not ready.");
    this.session.device.pushErrorScope("validation");
    let frame: FrameMetrics | undefined;
    try { frame = this.render(view); }
    finally {
      const error = await this.session.device.popErrorScope();
      if (error) { this.previousHiZ.invalidate(); this.shadows.invalidate(); this.shadowDirty = true;
        this.historyDirty = true; throw new Error(error.message); }
    }
    if (!frame) throw new Error("Surface is hidden or GPU device is unavailable.");
    await this.session.device.queue.onSubmittedWorkDone();
    if (this.session.state !== "ready" || this.session.diagnostics.length) throw new Error("GPU first frame failed; inspect device diagnostics.");
    return frame;
  }
  dispose(): void {
    this.environment.dispose();
    this.lighting.dispose();
    this.shadows.dispose();
    this.previousHiZ.dispose();
    this.transparency.dispose();
    this.postProcess.dispose();
    this.packets.dispose(); this.targets.dispose(); this.cameraHistory.reset(); this.session.dispose();
  }
  private validateView(view: RenderView): void {
    if (![...view.eye, ...view.target, ...(view.up ?? []), ...view.background, ...view.floor,
      view.extent, view.exposure, view.roughness].every(Number.isFinite)
      || view.extent <= 0 || view.exposure <= 0 || view.roughness <= 0) throw new Error("Invalid render view.");
  }
  private sceneChanged(): void { this.shadowDirty = true; this.historyDirty = true; }
}
