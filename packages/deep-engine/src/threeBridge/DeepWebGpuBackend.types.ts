/**
 * DeepWebGpuBackend 的类型合同(从 DeepWebGpuBackend.ts 原样拆出,零运行时影响):
 * 公共类型仍从 ./DeepWebGpuBackend.js re-export,消费方导入路径不变。
 */
import type { ProjectionIssue, ThreeObjectSource } from "./types.js";
import type { ThreeProjectionBridge } from "./ThreeProjectionBridge.js";
import type { InstanceUpdate, RenderPacket } from "../renderPacket.js";
import type { PbrRenderer, PbrRendererOptions, RenderView } from "../webgpu/pbrRenderer.js";
import type { FrameMetrics } from "../webgpu/pbrRenderer.js";
import type { ClusterLodSceneStaging } from "../webgpu/clusterLodRenderSlot.js";
import type { PbrEnvironmentSource } from "../webgpu/pbrEnvironmentSource.js";
import type { ProbeClipmapPbrController, ProbeClipmapPbrTarget } from "../webgpu/probeClipmapPbrController.js";
import type { HlodClusterStreamBinding } from "./hlodClusterStream.js";
import type { DeviceEvent } from "../webgpu/deviceSession.js";

export type DeepWebGpuCanvas = Parameters<typeof PbrRenderer.create>[0];

/** 可被宿主切换的自研浏览器后端；不持有作者场景，也不依赖 Three 运行时。 */
export interface DeepWebGpuRenderRuntime {
  readonly hdrDisplay?: PbrRenderer["hdrDisplay"];
  readonly id: string;
  readonly session?: {
    readonly state?: string;
    readonly device?: { readonly lost: Promise<unknown> };
    onDeviceRecreated?(listener: (epoch: number) => void): () => void;
    onFatalLoss?(listener: (reason: DeviceEvent) => void): () => void;
  };
  setPacketValidated(packet: RenderPacket, signal?: AbortSignal): Promise<void>;
  setPacket?(packet: RenderPacket): void;
  updateInstances(update: InstanceUpdate): void;
  render(view: RenderView): FrameMetrics | undefined;
  validateFrame(view: RenderView): Promise<FrameMetrics>;
  stageEnvironment?(source: PbrEnvironmentSource, signal?: AbortSignal): Promise<"staged" | "superseded">;
  stageShadowMapSize?(mapSize: number, signal?: AbortSignal): Promise<"staged" | "superseded">;
  /**
   * Optional production GI source. Implementations must return a controller
   * configured with real scene-radiance capture; omission keeps Studio IBL and
   * fails closed instead of publishing the probe runtime's test fallback.
   */
  createProbeClipmapController?(target: ProbeClipmapPbrTarget, deviceEpoch: string): ProbeClipmapPbrController;
  /**
   * G1 可选簇级微多边形槽位注入（PbrRenderer 同名方法的结构位）；缺省 = 运行时
   * 不支持，backend 记入 clusterLodStagingFailure 诊断而不断开渲染链。
   */
  stageClusterLodScene?(staging: ClusterLodSceneStaging): void;
  dispose(): void;
}

export interface DeepWebGpuBackendOptions {
  readonly authorChunks?: boolean;
  readonly meshlets?: boolean;
  readonly deformation?: boolean;
  /** Three 相机图层掩码；未传时使用默认图层 1。 */
  readonly cameraLayerMask?: number;
  /** Allocation evidence expected when preparing an existing runtime. */
  readonly expectedShadows?: NonNullable<PbrRendererOptions["shadows"]>;
  /**
   * B4 簇级 HLOD(opt-in):逐放置簇绑定;仅在独立 RenderPacket 路径生效
   * (代理几何/材质随包分发)。提供即每相机帧消费簇决策做驻留感知隐藏。
   */
  readonly hlodClusters?: readonly HlodClusterStreamBinding[];
  /** 宿主追加的折叠抑制信号(与编辑辅助 overlay 信号取或);true = 强制原件驻留。 */
  readonly hlodCollapseSuppressed?: () => boolean;
  /**
   * G1 簇级微多边形槽位(opt-in):宿主预构建的 bake 产物(作者包合并静态几何 →
   * bakeClusterLodDag)。静态包发布成功后由 backend 恰注入一次;注入失败只记
   * clusterLodStagingFailure 诊断,不打断渲染链。
   */
  readonly clusterLodStaging?: ClusterLodSceneStaging;
  /** C13 opt-in recovery configuration; omitted preserves the legacy behavior. */
  readonly recovery?: PbrRendererOptions["recovery"];
}

export interface DeepWebGpuRuntimeFactory {
  create(canvas: DeepWebGpuCanvas, gpu: GPU | undefined, signal: AbortSignal,
    options?: PbrRendererOptions): Promise<DeepWebGpuRenderRuntime>;
}

export interface DeepWebGpuBackendCreateRequest extends DeepWebGpuBackendOptions {
  readonly canvas: DeepWebGpuCanvas;
  readonly gpu: GPU | undefined;
  /** Legacy author projection. Omit when renderPacket is supplied. */
  readonly projection?: ThreeProjectionBridge;
  /** Legacy Three root. Omit when renderPacket is supplied. */
  readonly root?: ThreeObjectSource;
  readonly view: RenderView;
  /** Optional immutable packet compiled from SceneSnapshot. When present the
   * backend bypasses ThreeProjectionBridge for initial publication. */
  readonly renderPacket?: RenderPacket;
  readonly renderer?: PbrRendererOptions;
  readonly signal?: AbortSignal;
}

export type DeepWebGpuSyncResult =
  | { readonly status: "committed"; readonly update: "full" | "instances"; readonly packet: RenderPacket }
  | { readonly status: "superseded"; readonly update: "full" | "instances"; readonly packet: RenderPacket }
  | { readonly status: "rejected"; readonly issues: readonly ProjectionIssue[] };

export type DeepWebGpuBackendRuntime = PbrRenderer;
