import { DeviceSession } from "./deviceSession.js";
import { uploadBuffer } from "./meshBuffers.js";
import { authoredShadowPipelines, PBR_FRAME_UNIFORM_FLOATS, type Pipelines } from "./pipelines.js";
import { createPbrPipelineSet } from "./pbrPipelineSet.js";
import { validatePbrFrame } from "./validatePbrFrame.js";
import { RenderTargets } from "./renderTargets.js";
import type { StudioEnvironment } from "./studioEnvironment.js";
import { PacketBuffers } from "./packetBuffers.js";
import type { InstanceUpdate, RenderPacket } from "../renderPacket.js";
import { spherePacket } from "./spherePacket.js";
import { CameraFrameHistory } from "./cameraFrameHistory.js";
import { PbrPostProcessChain, type PbrPostProcessInput } from "./pbrPostProcessChain.js";
import { resolvePbrPostProcessOverrides } from "./pbrPostProcessOverrides.js";
import { PbrTransparencyPass } from "./pbrTransparencyPass.js";
import { viewProjectionFrustum } from "./pbrFrusta.js";
import { pbrVisibilityInput } from "./pbrVisibilityInput.js";
import { ForwardPlusPbrRuntime } from "../lighting/forwardPlusPbrRuntime.js";
import { transformWorldLightsToView } from "../lighting/worldLights.js";
import { updatePbrFrameUniforms } from "./pbrFrameUniforms.js";
import { PreviousHiZVisibility, type PreviousHiZFramePlan } from "./previousHiZVisibility.js";
import { PbrShadowState } from "./pbrShadowState.js";
import { hasClusteredLights, resolvePbrSceneLighting } from "../lighting/pbrSceneLighting.js";
import type { FrameMetrics, PbrRendererOptions, RenderView } from "./pbrRendererTypes.js";
import type { ResidentPacketProjection } from "./residentPacketProjection.js";
import { resolvePbrRendererFeatures, type PbrRendererFeatures } from "./pbrRendererFeatures.js";
import { createPbrEnvironment, type PbrEnvironmentSource } from "./pbrEnvironmentSource.js";
import { PbrEnvironmentState, type EnvironmentStageResult } from "./pbrEnvironmentState.js";
import { PbrMainBindings } from "./pbrMainBindings.js";
import { PbrLodWork } from "./pbrLodWork.js";
import { runResourceCleanup } from "./resourceCleanup.js";
import { PbrOutputBindings } from "./pbrOutputBindings.js";
import { PbrRendererDiagnostics } from "./pbrRendererDiagnostics.js";
import { validatePbrRenderView } from "./pbrRenderViewValidation.js";
import { beginPbrOpaquePass } from "./pbrOpaquePass.js";
import { LocalSpotShadowRuntime } from "./localSpotShadowRuntime.js";
import { pbrDirectDisplayClear } from "./pbrDirectDisplay.js";
import { createPbrGround, drawPbrGround, type PbrGroundResources } from "./pbrGroundPass.js";
import { PbrTransientTexturePool } from "./pbrTransientTexturePool.js";
export type { FrameMetrics, PbrRendererOptions, RenderView } from "./pbrRendererTypes.js";
export class PbrRenderer {
  readonly id = "deep-webgpu";
  private readonly diagnostics: PbrRendererDiagnostics; get gpuTimer() { return this.diagnostics.gpuTimer; }
  get performanceTelemetry() { return this.diagnostics.performance; } get transientTextureStats() { return this.targets.transientStats; }
  private readonly packets: PacketBuffers; private readonly ground: PbrGroundResources;
  private readonly frameBuffer: GPUBuffer;
  private readonly mainBindings: PbrMainBindings;
  private readonly environment: PbrEnvironmentState;
  private readonly shadowState: PbrShadowState; private get shadows() { return this.shadowState.current; }
  private readonly targets: RenderTargets; private readonly transientTextures: PbrTransientTexturePool;
  private readonly postProcess: PbrPostProcessChain;
  private readonly transparency: PbrTransparencyPass; private readonly lighting: ForwardPlusPbrRuntime;
  private readonly localShadows: LocalSpotShadowRuntime;
  private readonly cameraHistory = new CameraFrameHistory();
  private readonly previousHiZ = new PreviousHiZVisibility();
  private pendingHiZ: PreviousHiZFramePlan | undefined; private readonly outputs: PbrOutputBindings;
  private readonly features: PbrRendererFeatures; private frame = 0;
  private readonly writeGeometryBuffers: boolean;
  private shadowDirty = true; private historyDirty = true;
  private previousAmbientOcclusion: boolean | undefined;
  private readonly frameData = new Float32Array(PBR_FRAME_UNIFORM_FLOATS);
  private constructor(readonly session: DeviceSession, private readonly pipelines: Pipelines, environment: StudioEnvironment,
    lighting: ForwardPlusPbrRuntime, localShadows: LocalSpotShadowRuntime, options: PbrRendererOptions, features: PbrRendererFeatures, deformationPipelines?: Pipelines) {
    this.diagnostics = new PbrRendererDiagnostics(session);
    this.packets = new PacketBuffers(session, pipelines.materialLayout, deformationPipelines, options.meshlets === true);
    this.writeGeometryBuffers = features.ambientOcclusion || features.temporalAa || !!deformationPipelines;
    this.ground = createPbrGround(session);
    this.frameBuffer = uploadBuffer(session, "Deep frame", this.frameData, GPUBufferUsage.UNIFORM);
    this.outputs = new PbrOutputBindings(session, pipelines, () => performance.now(), features.spatialAa);
    this.shadowState = new PbrShadowState(session, pipelines, options.shadows);
    this.environment = new PbrEnvironmentState(environment);
    this.mainBindings = new PbrMainBindings(session, pipelines, this.frameBuffer, this.shadows, environment);
    this.transientTextures = new PbrTransientTexturePool(session); this.targets = new RenderTargets(session, pipelines.output.getBindGroupLayout(0), this.outputs.buffer, this.transientTextures);
    this.features = features;
    this.postProcess = new PbrPostProcessChain(session, this.features);
    this.transparency = new PbrTransparencyPass(session, this.transientTextures);
    this.lighting = lighting; this.localShadows = localShadows;
  }
  static async create(canvas: HTMLCanvasElement, gpu: GPU | undefined, signal: AbortSignal, options: PbrRendererOptions = {}): Promise<PbrRenderer> {
    const session = await DeviceSession.open(canvas, gpu, signal);
    const cancel = (): void => session.dispose();
    let scopeOpen = false;
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) throw new DOMException("GPU preparation cancelled", "AbortError");
      session.device.pushErrorScope("validation"); scopeOpen = true;
      const localShadows = await LocalSpotShadowRuntime.create(session, signal), lighting = new ForwardPlusPbrRuntime(session, localShadows.bindings);
      const features = resolvePbrRendererFeatures(options.features);
      const [{ pipelines, deformationPipelines }, environment] = await Promise.all([
        createPbrPipelineSet(session, lighting.layout, options, features),
        createPbrEnvironment(session, options.environment, signal),
      ]);
      if (signal.aborted || session.state !== "ready") throw new Error("GPU preparation interrupted.");
      const renderer = new PbrRenderer(session, pipelines, environment, lighting, localShadows, options, features, deformationPipelines);
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
  async setPacketValidated(packet: RenderPacket, signal?: AbortSignal): Promise<void> { if (await this.packets.setValidated(packet, signal)) this.sceneChanged(); }
  stageResidentPacket(projection: ResidentPacketProjection): void {
    this.packets.stageResidentProjection(projection);
  }
  async stageResidentPacketValidated(projection: ResidentPacketProjection,
    signal?: AbortSignal): Promise<void> {
    await this.packets.stageResidentProjectionValidated(projection, signal);
  }
  cancelResidentPacketStage(): void { this.packets.cancelPendingPacketStage(); }
  async setInstancesValidated(data: Float32Array<ArrayBuffer>, signal?: AbortSignal): Promise<void> { await this.setPacketValidated(spherePacket(data), signal); }
  setDiagnosticsSampling(enabled: boolean): void { this.diagnostics.setEnabled(enabled); } updateInstances(update: InstanceUpdate): void { if (this.packets.updateInstances(update)) this.shadowDirty = true; }
  setProbeClipmap(binding?: Parameters<ForwardPlusPbrRuntime["setProbeClipmap"]>[0]): void { this.lighting.setProbeClipmap(binding); this.historyDirty = true; }
  stageEnvironment(source: PbrEnvironmentSource, signal?: AbortSignal): Promise<EnvironmentStageResult> {
    return this.environment.stage(candidateSignal => createPbrEnvironment(this.session, source, candidateSignal), signal); }
  stageShadowMapSize(mapSize: number, signal?: AbortSignal): Promise<EnvironmentStageResult> { return this.shadowState.stage(mapSize, signal); }
  render(view: RenderView): FrameMetrics | undefined { return this.environment.runFrame(() => this.renderPreparedFrame(view), previous => this.mainBindings.setEnvironment(previous)); }
  private renderPreparedFrame(view: RenderView): FrameMetrics | undefined {
    const begin = performance.now();
    if (this.session.state !== "ready") return undefined;
    if (this.session.hasErrors) throw new Error("GPU validation failed; inspect device diagnostics.");
    validatePbrRenderView(view);
    const postProcess = resolvePbrPostProcessOverrides(view.postProcess, this.features);
    if (this.previousAmbientOcclusion !== undefined && this.previousAmbientOcclusion !== postProcess.ambientOcclusion) {
      this.historyDirty = true;
    }
    if (this.environment.beginFrame(candidate => this.mainBindings.setEnvironment(candidate))) this.historyDirty = true;
    const sceneLighting = resolvePbrSceneLighting(view.lights);
    if (this.mainBindings.update(view.lights, view.fog)) this.historyDirty = true;
    if (this.pendingHiZ) { this.previousHiZ.failFrame(this.pendingHiZ); this.pendingHiZ = undefined; }
    this.packets.failLodFrame();
    this.packets.cancelDeformationFrame();
    this.cameraHistory.cancelPendingFrame();
    try {
      if (this.packets.publishResidentProjection()) this.sceneChanged();
    } catch (error) {
      this.sceneChanged(); throw error;
    }
    const size = this.session.resize(view.width, view.height, view.pixelRatio);
    if (!size) return undefined;
    if (this.shadowState.publish(sceneLighting.primary.shadow?.mapSize, candidate => this.mainBindings.setShadows(candidate, this.environment.current))) this.sceneChanged();
    const drawProfile = this.packets.drawProfile();
    const directClear = drawProfile.hasDeformation || view.authorGrid ? undefined : pbrDirectDisplayClear(view, this.features, drawProfile.hasTransparent);
    const directionalDisplay = directClear !== undefined && !this.lighting.hasProbeClipmap && !hasClusteredLights(sceneLighting.clustered)
      && !drawProfile.hasMaterialTextures && this.pipelines.displayDirectionalMain !== undefined;
    const frameState = updatePbrFrameUniforms(this.session.device.queue, this.cameraHistory, view,
      size.width, size.height, this.historyDirty, { frameBuffer: this.frameBuffer, outputBuffer: this.outputs.buffer,
        groundInstance: this.ground.instance, frameData: this.frameData, outputData: this.outputs.data, groundData: this.ground.data },
      sceneLighting.primary, this.features);
    const history = frameState.history;
    const hiZPlan = this.features.occlusionCulling ? this.previousHiZ.beginFrame({
      frameRevision: history.revision, sceneRevision: this.packets.visibilityRevision,
      depthViewProjection: frameState.depthViewProjection, stableViewProjection: frameState.stableViewProjection, cameraPosition: view.eye,
      viewport: [size.width, size.height], reversedZ: false, cameraCut: history.cameraCut,
    }) : undefined;
    this.pendingHiZ = hiZPlan;
    const device = this.session.device;
    let submitAttempted = false;
    try {
      this.targets.beginFrame(size); const encoder = device.createCommandEncoder({ label: "Deep frame" });
    this.packets.encodeDeformation(encoder);
    const visibility = pbrVisibilityInput(view, frameState.projection, size.width, size.height, history.cameraCut);
    const mainFrustum = visibility.frustum, lodStats = this.packets.encodeLod(encoder, visibility.lod);
    const lodWork = new PbrLodWork(lodStats);
    const lighting = directionalDisplay ? undefined : this.lighting.prepareAndEncode(encoder, { viewportWidth: size.width, viewportHeight: size.height,
      near: frameState.projection.near, far: frameState.projection.far,
      verticalFovRadians: frameState.projection.verticalFovRadians,
      lights: transformWorldLightsToView(sceneLighting.clustered, frameState.worldToView) });
    const timing = this.gpuTimer.begin(this.frame + 1);
    const timingStart = timing ? { timestampWrites: { querySet: timing.queries, beginningOfPassWriteIndex: 0 } } : {};
    const shadowFrame = this.shadows.prepare({ eye: view.eye, target: view.target, ...(view.up ? { up: view.up } : {}),
      verticalFovRadians: frameState.projection.verticalFovRadians, aspect: size.width / size.height,
      near: frameState.projection.near, far: frameState.projection.far, extent: view.extent,
      lightDirection: sceneLighting.primary.rayDirectionWorld, ...(sceneLighting.primary.shadow ? { authored: sceneLighting.primary.shadow, viewportHeight: size.height } : {}) }, this.shadowDirty, sceneLighting.primary.castShadow !== false);
    let shadowUpdated = shadowFrame.render;
    let drawCalls = view.panoramaBackground ? 1 : 0, triangles = drawCalls;
    if (shadowUpdated) {
      const shadowLodStats = this.packets.encodeShadowLod(encoder, shadowFrame.plan);
      lodWork.add(shadowLodStats);
      shadowFrame.plan.cascades.forEach((cascade, index) => {
        this.packets.encodeCulling(encoder, viewProjectionFrustum(cascade.viewProjection), "shadow", undefined, index);
        const shadow = encoder.beginRenderPass({ label: `Deep shadow cascade ${index}`,
          ...(index === 0 ? timingStart : {}), colorAttachments: [], depthStencilAttachment: {
            view: this.shadows.layerViews[index]!, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store",
          } });
        shadow.setPipeline(this.pipelines.shadow);
        shadow.setBindGroup(0, this.shadows.frameBindings[index]!);
        const stats = this.packets.draw(shadow, sceneLighting.primary.shadow ? authoredShadowPipelines(this.pipelines) : this.pipelines, "shadow", undefined, true, index, false, !!sceneLighting.primary.shadow);
        drawCalls += stats.drawCalls; triangles += stats.triangles;
        shadow.end();
      });
    }
    const localShadow = lighting ? this.localShadows.prepareAndEncode(encoder, this.packets, this.pipelines, sceneLighting.clustered,
      this.shadowDirty, !shadowUpdated && timing ? timingStart.timestampWrites : undefined) : { rendered: false, drawCalls: 0, triangles: 0 };
    shadowUpdated ||= localShadow.rendered; drawCalls += localShadow.drawCalls; triangles += localShadow.triangles;
    lodWork.add(localShadow);
    const previousHiZ = hiZPlan ? this.previousHiZ.occlusionView(hiZPlan) : undefined;
    const opaqueCulling = this.packets.encodeCulling(encoder, mainFrustum, "opaque",
      { sceneRevision: this.packets.visibilityRevision, ...(previousHiZ ? { previousHiZ } : {}) });
    const hasTransparent = drawProfile.hasTransparent;
    let present = directClear ? this.outputs.acquirePresent(this.performanceTelemetry.enabled) : undefined;
    const mainTimestamps = directClear && timing && !view.editorOverlay?.vertices.length ? { querySet: timing.queries,
      ...(!shadowUpdated ? { beginningOfPassWriteIndex: 0 } : {}), endOfPassWriteIndex: 1 }
      : !shadowUpdated && timing ? timingStart.timestampWrites : undefined;
    const main = beginPbrOpaquePass(encoder, { targets: this.targets, background: directClear ?? view.background,
      writeGeometryBuffers: this.writeGeometryBuffers, drawBackground: this.mainBindings.prepareBackground(view, this.environment.current, size.width / size.height, this.writeGeometryBuffers),
      ...(present ? { directDisplayView: present.view } : {}), ...(mainTimestamps ? { timestampWrites: mainTimestamps } : {}) });
    main.setPipeline(directClear ? this.pipelines.displayMain! : this.pipelines.main);
    main.setBindGroup(0, this.mainBindings.binding);
    main.setBindGroup(2, this.shadows.binding);
    if (lighting) main.setBindGroup(lighting.bindGroupIndex, lighting.bindGroup);
    const stats = this.packets.draw(main, this.pipelines, directClear ? "display" : "opaque", undefined, true, 0, directionalDisplay);
    drawCalls += stats.drawCalls; triangles += stats.triangles;
    const groundStats = drawPbrGround(this.features.groundPlane, main,
      directClear && directionalDisplay ? this.pipelines.displayDirectionalMain! : directClear ? this.pipelines.displayMain! : this.pipelines.main,
      this.ground.mesh, this.ground.instance, directClear !== undefined);
    drawCalls += groundStats.drawCalls; triangles += groundStats.triangles;
    main.end();
    const gridTriangles = this.ground.author.encode(encoder, this.targets.hdr, this.targets.depth, frameState.depthViewProjection, frameState.worldToView, view.authorGrid);
    if (gridTriangles) { drawCalls++; triangles += gridTriangles; }
    const postProcessInput: PbrPostProcessInput = { encoder, targets: this.targets, revision: history.revision, postProcess,
      extent: view.extent, verticalFovRadians: frameState.projection.verticalFovRadians,
      cameraCut: history.cameraCut, currentJitter: history.currentJitter,
      previousJitter: history.previousJitter };
    const opaqueEffects: ReturnType<PbrPostProcessChain["encodeOpaque"]> = directClear
      ? { color: this.targets.hdrTexture, passCount: 0 } : this.postProcess.encodeOpaque(postProcessInput);
    if (hiZPlan && !opaqueEffects.hiZ) throw new Error("Hi-Z visibility enabled without a produced depth pyramid.");
    let temporalInput = opaqueEffects.color;
    if (hasTransparent) {
      const transparentStats = this.transparency.encode({ encoder, opaqueColor: opaqueEffects.color,
        hdrColor: this.targets.hdrTexture, hdrView: this.targets.hdr, depthView: this.targets.depth,
        viewOf: texture => this.outputs.view(texture), draw: pass => {
          pass.setBindGroup(0, this.mainBindings.binding); pass.setBindGroup(2, this.shadows.binding);
          pass.setBindGroup(lighting!.bindGroupIndex, lighting!.bindGroup);
          return this.packets.draw(pass, this.pipelines, "transparent", undefined, true);
        } });
      temporalInput = transparentStats.color;
      drawCalls += transparentStats.drawCalls; triangles += transparentStats.triangles;
    }
    const finalEffects = directClear ? { color: temporalInput, passCount: 0 }
      : this.postProcess.encodeFinal(postProcessInput, temporalInput);
    if (!directClear) {
      present = this.outputs.present(encoder, finalEffects.color, view.authorColorEffects, this.performanceTelemetry.enabled,
        view.editorOverlay?.vertices.length ? undefined : timing?.queries);
      drawCalls += this.features.spatialAa ? 2 : 1; triangles += this.features.spatialAa ? 2 : 1;
    }
    const overlayTriangles = this.outputs.encodeEditorOverlay(encoder, present!.view, view.editorOverlay, timing?.queries);
    if (overlayTriangles) { drawCalls++; triangles += overlayTriangles; }
    timing?.resolve(encoder);
    const commands = encoder.finish();
    const encoded = this.performanceTelemetry.enabled ? performance.now() : 0, frameNumber = this.frame + 1;
    submitAttempted = true; device.queue.submit([commands]); this.targets.commitFrame();
    const submitted = this.performanceTelemetry.enabled ? performance.now() : 0;
    this.packets.commitLodFrame();
    this.shadows.commit(); this.localShadows.commit();
    this.cameraHistory.commitFrame(history);
    this.previousAmbientOcclusion = postProcess.ambientOcclusion;
    if (hiZPlan) this.previousHiZ.commitFrame(hiZPlan, opaqueEffects.hiZ!);
    this.pendingHiZ = undefined;
    this.packets.commitFrame();
    timing?.read();
    this.shadowDirty = false; this.historyDirty = false;
    this.diagnostics.recordFrame(frameNumber, begin, encoded, submitted, present!.acquireMs);
    return { frame: ++this.frame, cpuSubmitMs: performance.now() - begin, drawCalls, triangles, ...lodWork.snapshot(),
      width: size.width, height: size.height, resources: this.session.resourceCount, shadowUpdated, transientTextures: this.targets.transientStats,
      cameraCut: history.cameraCut, postProcessPasses: opaqueEffects.passCount + finalEffects.passCount + (hasTransparent ? 2 : 0) + (!directClear && this.features.spatialAa ? 1 : 0),
      weightedOit: hasTransparent,
      hiZMipLevels: opaqueEffects.hiZ?.mipLevelCount ?? 0,
      occlusionCulling: opaqueCulling.occlusionBatches > 0,
      frustumCulledBatches: opaqueCulling.frustumBatches, hiZOccludedBatches: opaqueCulling.occlusionBatches, lodSelectionBatches: lodStats.selectionBatches, lodIndirectDraws: lodStats.indirectDraws,
      lightCount: lighting?.lightCount ?? 0, lightClusters: lighting?.grid.clusterCount ?? 0,
      ...this.shadows.metrics };
    } catch (error) {
      this.targets.failFrame();
      this.packets.cancelDeformationFrame();
      if (submitAttempted) this.packets.failLodFrame(); else this.packets.cancelLodFrame();
      this.lighting.invalidateAssignment(); this.localShadows.failFrame(); this.cameraHistory.cancelPendingFrame();
      if (hiZPlan) this.previousHiZ.failFrame(hiZPlan); this.pendingHiZ = undefined;
      throw error;
    }
  }
  async validateFrame(view: RenderView): Promise<FrameMetrics> {
    return validatePbrFrame(this.session, () => this.render(view), () => {
      this.previousHiZ.invalidate(); this.shadows.invalidate(); this.localShadows.invalidate();
      this.shadowDirty = true; this.historyDirty = true;
    });
  }
  dispose(): void {
    const owners = [this.ground.author, this.outputs, this.environment, this.lighting, this.localShadows,
      this.shadowState, this.previousHiZ, this.transparency, this.postProcess, this.packets, this.targets];
    runResourceCleanup("PBR renderer cleanup failed.", [...owners.map(owner => () => owner.dispose()),
      () => this.cameraHistory.reset(), () => this.session.dispose()]);
  }
  private sceneChanged(): void { this.shadowDirty = true; this.historyDirty = true; }
}
