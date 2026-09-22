import { DeviceSession } from "./deviceSession.js";
import { uploadBuffer } from "./meshBuffers.js";
import { authoredShadowPipelines, PBR_FRAME_UNIFORM_FLOATS, type Pipelines } from "./pipelines.js";
import { openPbrRenderer } from "./pbrRendererBootstrap.js";
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
import type { PbrRendererFeatures } from "./pbrRendererFeatures.js";
import { createPbrEnvironment, type PbrEnvironmentSource } from "./pbrEnvironmentSource.js";
import { PbrEnvironmentState, type EnvironmentStageResult } from "./pbrEnvironmentState.js";
import { PbrMainBindings } from "./pbrMainBindings.js";
import { PbrLodWork } from "./pbrLodWork.js";
import { runResourceCleanup } from "./resourceCleanup.js";
import { PbrOutputBindings, type PbrPresentReceipt } from "./pbrOutputBindings.js";
import { PbrRendererDiagnostics } from "./pbrRendererDiagnostics.js";
import { validatePbrRenderView } from "./pbrRenderViewValidation.js";
import { beginPbrOpaquePass } from "./pbrOpaquePass.js";
import { LocalSpotShadowRuntime } from "./localSpotShadowRuntime.js";
import { pbrDirectDisplayClear } from "./pbrDirectDisplay.js";
import { createPbrGround, drawPbrGround, type PbrGroundResources } from "./pbrGroundPass.js";
import { PbrTransientTexturePool } from "./pbrTransientTexturePool.js";
import { buildPbrFrameExecutionPlan, collectActualPbrFramePasses, assertPlanMatchesActual } from "./pbrFramePlanExecutor.js";
import { PbrFrameCapture } from "./pbrFrameCapture.js";
import type { PbrFrameReadbackResult } from "./pbrFrameCaptureReadback.js";
import type { FrameCaptureSession } from "../r12/frameCapture.js";
import { compilePbrFrameGraph } from "./pbrFrameGraph.js";
import { encodeRenderGraphEncoderGroup } from "./renderGraphEncoderExecutor.js";
import type { RenderGraphCompileResult } from "../renderGraph.js";
import { AdaptiveQualityController, adaptiveShadowMapSize } from "./adaptiveQuality.js";
import type { CascadedShadowQualityTier } from "../shadows/shadowQuality.js";
import { ProbeClipmapPbrController } from "./probeClipmapPbrController.js";
import { VisibilityBufferPath } from "./visibilityBufferPass.js";
import { SoftRasterizeFallback } from "./softRasterizeFallback.js";
export type { FrameMetrics, PbrRendererOptions, RenderView } from "./pbrRendererTypes.js";
export class PbrRenderer {
  readonly id = "deep-webgpu";
  private readonly diagnostics: PbrRendererDiagnostics; get gpuTimer() { return this.diagnostics.gpuTimer; }
  get performanceTelemetry() { return this.diagnostics.performance; } get transientTextureStats() { return this.targets.transientStats; }
  get materialBindingStats() { return this.packets.materialBindingStats; }
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
  private readonly frameCapture: PbrFrameCapture | undefined;
  private lastFrameReadback: Promise<readonly PbrFrameReadbackResult[]> | undefined;
  get frameReadbackResults(): Promise<readonly PbrFrameReadbackResult[]> | undefined { return this.lastFrameReadback; }
  private lastAuthorShadowSize: number | undefined;
  private readonly optionsExactShadowCascade: number | undefined;
  private adaptiveShadowTier: CascadedShadowQualityTier | undefined;
  private adaptiveShadowSize: number | undefined;
  private adaptiveShadowStage: AbortController | undefined;
  private readonly probeClipmap: ProbeClipmapPbrController | undefined;
  private probeClipmapBusy = false;
  private readonly probeClipmapAbort = new AbortController();
  private probeClipmapFailed = false;
  private readonly visibility: VisibilityBufferPath | undefined;
  private readonly adaptiveQuality: AdaptiveQualityController | undefined;
  private readonly preparationPlan: RenderGraphCompileResult;
  private readonly preparationGroupIndex: number;
  private allocationPlanKey: string | undefined;
  private allocationPlan: RenderGraphCompileResult | undefined;
  private capturePlanKey: string | undefined;
  private capturePlan: ReturnType<typeof buildPbrFrameExecutionPlan> | undefined;
  private captureActualPasses: ReturnType<typeof collectActualPbrFramePasses> | undefined;
  private readonly writeGeometryBuffers: boolean;
  private shadowDirty = true; private historyDirty = true;
  private previousAmbientOcclusion: boolean | undefined;
  private previousTemporalLights: RenderView["lights"];
  private temporalLightRevision = 0;
  private readonly frameData = new Float32Array(PBR_FRAME_UNIFORM_FLOATS);
  private constructor(readonly session: DeviceSession, private readonly pipelines: Pipelines, environment: StudioEnvironment,
    lighting: ForwardPlusPbrRuntime, localShadows: LocalSpotShadowRuntime, options: PbrRendererOptions, features: PbrRendererFeatures, deformationPipelines?: Pipelines) {
    this.diagnostics = new PbrRendererDiagnostics(session);
    this.adaptiveQuality = options.adaptiveQuality ? new AdaptiveQualityController(options.adaptiveQuality) : undefined;
    if (options.adaptiveQuality?.enabled) this.diagnostics.setEnabled(true);
    this.probeClipmap = options.probeClipmap === undefined ? undefined
      : new ProbeClipmapPbrController(this, probeClipmapDeviceEpoch(session.device), options.probeClipmap);
    this.packets = new PacketBuffers(session, pipelines.materialLayout, deformationPipelines, options.meshlets === true, features.visibilityBuffer);
    this.writeGeometryBuffers = features.ambientOcclusion || features.screenSpaceReflection || features.volumetricFog || features.temporalAa
      || !!deformationPipelines;
    this.ground = createPbrGround(session);
    this.frameBuffer = uploadBuffer(session, "Deep frame", this.frameData, GPUBufferUsage.UNIFORM);
    this.outputs = new PbrOutputBindings(session, pipelines, () => performance.now(), features.spatialAa);
    this.shadowState = new PbrShadowState(session, pipelines, options.shadows);
    this.optionsExactShadowCascade = options.shadows?.exactProfile?.cascadeCount;
    this.lastAuthorShadowSize = options.shadows?.exactProfile?.shadowMapSize;
    this.environment = new PbrEnvironmentState(environment);
    this.mainBindings = new PbrMainBindings(session, pipelines, this.frameBuffer, this.shadows, environment);
    this.transientTextures = new PbrTransientTexturePool(session, options.transientTextureBudgetBytes); this.targets = new RenderTargets(session, pipelines.output.getBindGroupLayout(0), this.outputs.buffer, this.transientTextures);
    this.features = features;
    // P0-2 可见性切片（opt-in）：共享 frame uniform 与 transient 池；默认 features.visibilityBuffer=false 时不构建。
    this.visibility = features.visibilityBuffer ? new VisibilityBufferPath(session, this.transientTextures, this.frameBuffer,
      features.softRasterizeFallback ? new SoftRasterizeFallback(session) : undefined) : undefined;
    if (this.visibility) void this.visibility.ensure();
    this.preparationPlan = compilePbrFrameGraph({ transparency: true, features,
      writeGeometryBuffers: this.writeGeometryBuffers });
    this.preparationGroupIndex = this.preparationPlan.parallelGroups?.findIndex(group =>
      group.length === 2 && group.includes("deform") && group.includes("cluster-lights")) ?? -1;
    this.frameCapture = options.frameCapture === undefined ? undefined : new PbrFrameCapture({ ...options.frameCapture,
      now: options.frameCapture.now ?? (() => performance.now()) }, { builtinRenderer: true });
    this.postProcess = new PbrPostProcessChain(session, this.features, this.transientTextures);
    this.transparency = new PbrTransparencyPass(session, this.transientTextures);
    this.lighting = lighting; this.localShadows = localShadows;
  }
  get frameCaptureSession(): FrameCaptureSession | undefined { return this.frameCapture?.session; }
  static async create(canvas: HTMLCanvasElement, gpu: GPU | undefined, signal: AbortSignal, options: PbrRendererOptions = {}): Promise<PbrRenderer> {
    const session = await DeviceSession.open(canvas, gpu, signal, options.deviceMemoryBudgetBytes);
    return openPbrRenderer(session, signal, options, () => new DOMException("GPU preparation cancelled", "AbortError"),
      (...args) => new PbrRenderer(...args));
  }
  setInstances(data: Float32Array<ArrayBuffer>): void { this.setPacket(spherePacket(data)); }
  setPacket(packet: RenderPacket): void {
    if (this.packets.set(packet)) { this.sceneChanged(); this.syncProbeClipmapSurfaces(packet); }
  }
  async setPacketValidated(packet: RenderPacket, signal?: AbortSignal): Promise<void> {
    if (await this.packets.setValidated(packet, signal)) { this.sceneChanged(); this.syncProbeClipmapSurfaces(packet); }
  }
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
  /** Chunk streaming reads this when a new residency catalog is created; 1 keeps the fixed budget. */
  residencyBudgetScale(): number { return this.adaptiveQuality?.state().knobs.residencyBudgetScale ?? 1; }
  /** The author map size is a ceiling: adaptive pressure only ever asks for equal or less. */
  private refreshAdaptiveShadowRequest(authorShadowSize: number | undefined): void {
    const state = this.adaptiveQuality?.state();
    if (!state?.enabled) { this.adaptiveShadowSize = undefined; return; }
    if (state.knobs.shadowTier === this.adaptiveShadowTier) return;
    this.adaptiveShadowTier = state.knobs.shadowTier;
    this.adaptiveShadowSize = adaptiveShadowMapSize(state.knobs.shadowTier, authorShadowSize);
  }
  private stageAdaptiveShadow(mapSize: number): void {
    if (this.optionsExactShadowCascade !== 1) return;
    const controller = new AbortController();
    this.adaptiveShadowStage = controller;
    void this.shadowState.stage(mapSize, controller.signal)
      .then(result => { if (result !== "staged") this.adaptiveShadowSize = undefined; })
      .catch(() => { this.adaptiveShadowSize = undefined; })
      .finally(() => { if (this.adaptiveShadowStage === controller) this.adaptiveShadowStage = undefined; });
  }
  /** Packet identity is the surface-cache input; the freshly advanced scene revision is the sync epoch. */
  private syncProbeClipmapSurfaces(packet: RenderPacket): void {
    if (this.probeClipmap === undefined || this.probeClipmapFailed) return;
    const revision = this.packets.visibilityRevision;
    if (revision < 1) return;
    try { this.probeClipmap.syncRenderPacket({ packet, revision }); }
    catch { this.probeClipmapFailed = true; this.probeClipmap.dispose(); }
  }
  /** Fire-and-forget GI update; a still-busy frame is skipped by budget, never queued unboundedly. */
  private driveProbeClipmap(frame: number, size: { readonly width: number; readonly height: number },
    cameraPosition: readonly [number, number, number], cameraCut: boolean): void {
    const controller = this.probeClipmap;
    if (controller === undefined || this.probeClipmapBusy || this.probeClipmapAbort.signal.aborted) return;
    this.probeClipmapBusy = true;
    void controller.beginFrame({ frame, viewport: [size.width, size.height],
      cameraPosition, cameraCut, sceneBounds: controller.sceneBounds }, this.probeClipmapAbort.signal)
      .catch(() => { /* runtime records its own failed diagnostics; the render loop must survive. */ })
      .finally(() => { this.probeClipmapBusy = false; });
  }
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
    if (view.lights !== this.previousTemporalLights) {
      this.previousTemporalLights = view.lights; this.temporalLightRevision += 1;
    }
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
    const authorShadowSize = sceneLighting.primary.shadow?.mapSize;
    if (authorShadowSize !== this.lastAuthorShadowSize) {
      this.lastAuthorShadowSize = authorShadowSize;
      // A fresh author request supersedes any adaptive shadow request still in flight.
      this.adaptiveShadowSize = undefined;
    }
    this.refreshAdaptiveShadowRequest(authorShadowSize);
    const desiredShadowSize = this.adaptiveShadowSize ?? authorShadowSize;
    if (desiredShadowSize !== undefined && desiredShadowSize !== authorShadowSize
      && this.adaptiveShadowStage === undefined
      && desiredShadowSize !== this.shadowState.current.selection.profile.options.shadowMapSize) {
      this.stageAdaptiveShadow(desiredShadowSize);
    }
    if (this.shadowState.publish(desiredShadowSize, candidate => this.mainBindings.setShadows(candidate, this.environment.current))) this.sceneChanged();
    const drawProfile = this.packets.drawProfile();
    const directClear = drawProfile.hasDeformation || view.authorGrid ? undefined : pbrDirectDisplayClear(view, this.features, drawProfile.hasTransparent, this.writeGeometryBuffers);
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
    let captureOpen = false;
    try {
      const frameNumber = this.frame + 1;
      this.driveProbeClipmap(frameNumber, size, view.eye, history.cameraCut);
      const capturePlan = this.frameCapture ? this.captureForFrame(size, drawProfile.hasTransparent, postProcess, directClear !== undefined) : undefined;
      if (this.frameCapture && capturePlan) {
        this.frameCapture.begin(`frame-${frameNumber}`, capturePlan.plan);
        captureOpen = true;
      }
      const allocationPlan = this.allocationPlanFor(drawProfile.hasTransparent, postProcess, directClear !== undefined);
      // Capture can append readbacks outside the production graph; keep its resources physically distinct.
      this.targets.beginFrame(size, this.frameCapture ? [] : allocationPlan.resources);
    let lighting: ReturnType<ForwardPlusPbrRuntime["prepareAndEncode"]> | undefined;
    const preparation = directionalDisplay ? undefined : encodeRenderGraphEncoderGroup(device,
      this.preparationPlan, this.preparationGroupIndex, new Map([
        ["deform", ({ encoder }) => this.packets.encodeDeformation(encoder)],
        ["cluster-lights", ({ encoder }) => {
          lighting = this.lighting.prepareAndEncode(encoder, { viewportWidth: size.width, viewportHeight: size.height,
            near: frameState.projection.near, far: frameState.projection.far,
            verticalFovRadians: frameState.projection.verticalFovRadians,
            lights: transformWorldLightsToView(sceneLighting.clustered, frameState.worldToView) });
        }],
      ]), { encoderLabelPrefix: "Deep PBR prepare" });
    const encoder = device.createCommandEncoder({ label: "Deep frame" });
    if (!preparation) this.packets.encodeDeformation(encoder);
    const visibility = pbrVisibilityInput(view, frameState.projection, size.width, size.height, history.cameraCut,
      this.adaptiveQuality?.state().knobs.lodDetailScale ?? 1);
    const previousHiZ = hiZPlan ? this.previousHiZ.occlusionView(hiZPlan) : undefined;
    const mainFrustum = visibility.frustum, lodStats = this.packets.encodeLod(encoder,
      previousHiZ ? { ...visibility.lod, previousHiZ } : visibility.lod);
    const lodWork = new PbrLodWork(lodStats);
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
    const opaqueCulling = this.packets.encodeCulling(encoder, mainFrustum, "opaque",
      { sceneRevision: this.packets.visibilityRevision, ...(previousHiZ ? { previousHiZ } : {}) });
    const hasTransparent = drawProfile.hasTransparent;
    let present: PbrPresentReceipt | undefined = directClear ? this.outputs.acquirePresent(this.performanceTelemetry.enabled) : undefined;
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
    // P0-2 可见性合成（opt-in）：仅 HDR 管线路径；directDisplay 与 authorGrid 快路径保持逐字节不变。
    if (this.visibility && !directClear) {
      this.visibility.encodeComposite(encoder, { hdrView: this.targets.hdr, depthView: this.targets.depth,
        width: size.width, height: size.height, frameData: this.frameData, inputs: this.packets.visibilityInputs() });
    }
    // The chain owns override resolution. Keep the resolved snapshot above for
    // capture planning, but do not feed it back as if it were author input.
    const postProcessInput: PbrPostProcessInput = { encoder, targets: this.targets, revision: history.revision,
      ...(view.postProcess === undefined ? {} : { postProcess: view.postProcess }),
      extent: view.extent, verticalFovRadians: frameState.projection.verticalFovRadians,
      cameraCut: history.cameraCut, currentJitter: history.currentJitter,
      previousJitter: history.previousJitter, materialRevision: this.packets.visibilityRevision,
      lightRevision: this.temporalLightRevision, exposure: view.exposure, reactiveMaskAvailable: false,
      surfaceWidth: size.width, surfaceHeight: size.height,
      ...(this.adaptiveQuality ? { adaptiveQuality: this.adaptiveQuality.state().knobs } : {}) };
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
        view.editorOverlay?.vertices.length ? undefined : timing?.queries, this.frameCapture !== undefined);
      drawCalls += this.features.spatialAa ? 2 : 1; triangles += this.features.spatialAa ? 2 : 1;
    }
    const overlayTriangles = this.outputs.encodeEditorOverlay(encoder, present!.view, view.editorOverlay, timing?.queries);
    if (overlayTriangles) { drawCalls++; triangles += overlayTriangles; }
    if (this.frameCapture && captureOpen) {
      this.frameCapture.encodeReadbacks(encoder, device, {
        "present-color": finalEffects.color,
        "opaque-hdr": this.targets.hdrTexture,
        "linear-depth": this.targets.linearDepthTexture,
      });
    }
    timing?.resolve(encoder);
    const commands = encoder.finish();
    const encoded = this.performanceTelemetry.enabled ? performance.now() : 0;
    if (this.frameCapture && captureOpen) {
      const executedPassIds = this.executedCapturePassIds(directClear !== undefined, postProcess, hasTransparent);
      this.frameCapture.recordPasses(this.captureActualPasses ?? [], executedPassIds, present?.sourceMapRefs);
      this.frameCapture.mark("submit", "queue.submit");
    }
    submitAttempted = true; device.queue.submit([...(preparation?.commandBuffers ?? []), commands]); this.targets.commitFrame();
    if (this.frameCapture && captureOpen) this.lastFrameReadback = this.frameCapture.collectReadbacksAfterSubmit();
    this.postProcess.commitFrame(history.revision);
    const submitted = this.performanceTelemetry.enabled ? performance.now() : 0;
    if (this.frameCapture && captureOpen) {
      this.frameCapture.mark("submitted", "queue submitted");
      this.frameCapture.end();
      captureOpen = false;
    }
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
    const metrics: FrameMetrics = { frame: ++this.frame, cpuSubmitMs: performance.now() - begin, drawCalls, triangles, ...lodWork.snapshot(),
      width: size.width, height: size.height, resources: this.session.resourceCount, shadowUpdated, transientTextures: this.targets.transientStats,
      deviceResourceMemory: this.session.resourceMemory,
      cameraCut: history.cameraCut, postProcessPasses: opaqueEffects.passCount + finalEffects.passCount + (hasTransparent ? 2 : 0) + (!directClear && this.features.spatialAa ? 1 : 0),
      weightedOit: hasTransparent,
      hiZMipLevels: opaqueEffects.hiZ?.mipLevelCount ?? 0,
      occlusionCulling: opaqueCulling.occlusionBatches > 0,
      frustumCulledBatches: opaqueCulling.frustumBatches, hiZOccludedBatches: opaqueCulling.occlusionBatches, lodSelectionBatches: lodStats.selectionBatches, lodIndirectDraws: lodStats.indirectDraws,
      lightCount: lighting?.lightCount ?? 0, lightClusters: lighting?.grid.clusterCount ?? 0,
      ...this.shadows.metrics };
    this.sampleAdaptiveQuality(metrics);
    if (!this.adaptiveQuality) return metrics;
    const hotspots = this.adaptiveQuality.hotspotSummary();
    return { ...metrics, adaptiveQuality: this.adaptiveQuality.state(),
      ...(hotspots.length ? { adaptiveHotspots: hotspots } : {}) };
    } catch (error) {
      if (captureOpen) this.frameCapture?.cancel();
      this.postProcess.cancelFrame(history.revision);
      this.targets.failFrame();
      this.packets.cancelDeformationFrame();
      if (submitAttempted) this.packets.failLodFrame(); else this.packets.cancelLodFrame();
      this.lighting.invalidateAssignment(); this.localShadows.failFrame(); this.cameraHistory.cancelPendingFrame();
      if (hiZPlan) this.previousHiZ.failFrame(hiZPlan); this.pendingHiZ = undefined;
      throw error;
    }
  }
  private sampleAdaptiveQuality(metrics: FrameMetrics): void {
    if (!this.adaptiveQuality) return;
    const snapshot = this.performanceTelemetry.snapshot();
    const cpu = snapshot.stages["frame-encode"], gpu = snapshot.stages["gpu-frame"];
    if (!cpu) return;
    const samples = this.performanceTelemetry.samples("frame-encode");
    this.adaptiveQuality.sample({ frame: metrics.frame, sampleCount: cpu.samples, cpuP95Ms: cpu.p95Ms, cpuP99Ms: cpu.p99Ms,
      ...(gpu ? { gpuP95Ms: gpu.p95Ms, gpuP99Ms: gpu.p99Ms } : {}),
      longFrameCount: samples.filter(value => value > 33.34).length,
      width: metrics.width, height: metrics.height, drawCalls: metrics.drawCalls, triangles: metrics.triangles,
      memory: metrics.deviceResourceMemory ?? this.session.resourceMemory });
  }
  private captureForFrame(size: { readonly width: number; readonly height: number }, transparency: boolean,
    postProcess: ReturnType<typeof resolvePbrPostProcessOverrides>, directDisplay: boolean): {
    readonly plan: ReturnType<typeof buildPbrFrameExecutionPlan>;
    readonly actual: ReturnType<typeof collectActualPbrFramePasses>;
  } {
    const key = `${size.width}x${size.height}:${transparency ? "transparent" : "opaque"}`
      + `:ao=${postProcess.ambientOcclusion ? 1 : 0}:ssr=${postProcess.screenSpaceReflection ? 1 : 0}`
      + `:fog=${postProcess.volumetricFog ? 1 : 0}:bloom=${postProcess.bloom ? 1 : 0}:direct=${directDisplay ? 1 : 0}`;
    if (this.capturePlanKey !== key || !this.capturePlan || !this.captureActualPasses) {
      const captureFeatures: PbrRendererFeatures = Object.freeze({ ...this.features,
        ambientOcclusion: postProcess.ambientOcclusion,
        screenSpaceReflection: postProcess.screenSpaceReflection,
        volumetricFog: postProcess.volumetricFog,
        bloom: postProcess.bloom,
      });
      const opaqueColorResource = postProcess.ambientOcclusion ? "ao-hdr" : "opaque-hdr";
      const plan = buildPbrFrameExecutionPlan(size, { transparency, features: captureFeatures,
        directDisplay, writeGeometryBuffers: this.writeGeometryBuffers });
      const presentInputResource = postProcess.bloom ? "bloom-hdr"
        : this.features.temporalAa ? "temporal-hdr" : postProcess.screenSpaceReflection ? "ssr-hdr"
          : postProcess.volumetricFog ? "volumetric-fog-hdr"
          : transparency ? "composited-hdr" : opaqueColorResource;
      const actual = collectActualPbrFramePasses(captureFeatures, transparency,
        { opaqueColorResource, presentInputResource, directDisplay, writeGeometryBuffers: this.writeGeometryBuffers });
      assertPlanMatchesActual(plan, actual);
      this.capturePlan = plan;
      this.captureActualPasses = actual;
      this.capturePlanKey = key;
    }
    return { plan: this.capturePlan, actual: this.captureActualPasses };
  }
  private allocationPlanFor(transparency: boolean,
    postProcess: ReturnType<typeof resolvePbrPostProcessOverrides>, directDisplay: boolean): RenderGraphCompileResult {
    const key = `${transparency ? 1 : 0}:${postProcess.ambientOcclusion ? 1 : 0}:${postProcess.screenSpaceReflection ? 1 : 0}`
      + `:${postProcess.volumetricFog ? 1 : 0}:${postProcess.bloom ? 1 : 0}:${directDisplay ? 1 : 0}`;
    if (this.allocationPlanKey !== key || !this.allocationPlan) {
      this.allocationPlan = compilePbrFrameGraph({ transparency, features: { ...this.features,
        ambientOcclusion: postProcess.ambientOcclusion, screenSpaceReflection: postProcess.screenSpaceReflection,
        volumetricFog: postProcess.volumetricFog, bloom: postProcess.bloom }, directDisplay,
        writeGeometryBuffers: this.writeGeometryBuffers });
      if (!this.allocationPlan.valid) throw new Error("PBR transient allocation graph is invalid.");
      this.allocationPlanKey = key;
    }
    return this.allocationPlan;
  }
  private executedCapturePassIds(directClear: boolean, postProcess: ReturnType<typeof resolvePbrPostProcessOverrides>,
    transparency: boolean): ReadonlySet<string> {
    const ids = new Set<string>(["opaque"]);
    if (directClear) return ids;
    if (postProcess.ambientOcclusion) { ids.add("ambient-occlusion"); ids.add("apply-ambient-occlusion"); }
    if (postProcess.screenSpaceReflection) { ids.add("screen-space-reflection-trace"); ids.add("screen-space-reflection-composite"); }
    if (transparency) { ids.add("transparent-oit"); ids.add("composite-oit"); }
    if (postProcess.volumetricFog) { ids.add("volumetric-fog-march"); ids.add("volumetric-fog-composite"); }
    if (this.features.temporalAa) ids.add("temporal-aa");
    if (postProcess.bloom) ids.add("bloom");
    ids.add("present");
    return ids;
  }
  async validateFrame(view: RenderView): Promise<FrameMetrics> {
    return validatePbrFrame(this.session, () => this.render(view), () => {
      this.previousHiZ.invalidate(); this.shadows.invalidate(); this.localShadows.invalidate();
      this.shadowDirty = true; this.historyDirty = true;
    });
  }
  dispose(): void {
    // 可选链：测试以手造对象直调原型 dispose，字段可能不存在。
    this.probeClipmapAbort?.abort();
    this.probeClipmap?.dispose();
    const owners = [this.ground.author, this.outputs, this.environment, this.lighting, this.localShadows,
      this.shadowState, this.previousHiZ, this.transparency, this.postProcess, this.packets, this.targets,
      ...(this.visibility ? [this.visibility] : [])];
    runResourceCleanup("PBR renderer cleanup failed.", [...owners.map(owner => () => owner.dispose()),
      () => this.cameraHistory.reset(), () => this.session.dispose()]);
  }
  private sceneChanged(): void { this.shadowDirty = true; this.historyDirty = true; }
}

const probeClipmapDeviceEpochs = new WeakMap<object, string>();
let probeClipmapEpochCounter = 0;
function probeClipmapDeviceEpoch(device: GPUDevice): string {
  const cached = probeClipmapDeviceEpochs.get(device);
  if (cached !== undefined) return cached;
  const created = `deep-probe-clipmap-${++probeClipmapEpochCounter}`;
  probeClipmapDeviceEpochs.set(device, created);
  return created;
}
