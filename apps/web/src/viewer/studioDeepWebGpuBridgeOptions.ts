import type { HlodClusterStreamBinding } from "@bim-studio/deep-engine/three-bridge";
import type { DeviceRecoveryOptions, HdrDisplayRequest } from "@bim-studio/deep-engine/webgpu";
import type { RenderPacket } from "@bim-studio/deep-engine";
import type { StudioQualityTelemetryOptions } from "./StudioDeepQualityTelemetry";
import type { RendererBackend } from "./viewerTypes";
import type { BridgeModuleLoader } from "./studioDeepWebGpuBridgeSceneHelpers";

export interface StudioDeepWebGpuBridgeOptions {
  /** Physical display opt-in. Runtime reports a specific SDR fallback when HDR is unavailable. */
  readonly hdrDisplay?: HdrDisplayRequest;
  readonly onRuntimeFailure?: (error: Error) => void;
  readonly loadModule?: BridgeModuleLoader;
  readonly preparationTimeoutMs?: number;
  /** Maximum submitted camera views awaiting GPU queue completion. */
  readonly cameraFrameInFlightLimit?: 1 | 2;
  /** Optional packet compiled from SceneSnapshot; when provided Deep skips
   * Three scene projection for candidate publication. */
  readonly authorRenderPacket?: (signal: AbortSignal) => Promise<RenderPacket | undefined>;
  /**
   * B4 簇级 HLOD(opt-in,`b4-hlod-cluster=1`):逐放置簇绑定提供方;仅在独立
   * 作者包路径下被消费,与 authorRenderPacket 共享同一编译缓存由宿主保证。
   */
  readonly authorHlodClusters?: (signal: AbortSignal) => Promise<readonly HlodClusterStreamBinding[] | undefined>;
  /** T25 质量遥测采样配置;缺省 4Hz 聚合、256 帧窗口。 */
  readonly qualityTelemetry?: StudioQualityTelemetryOptions;
  /** C13 recovery is explicit opt-in; omitted keeps the legacy bridge behavior. */
  readonly recovery?: DeviceRecoveryOptions;
}

export interface StudioRendererSwitchResult {
  readonly status: "switched" | "unchanged" | "cancelled" | "failed";
  readonly activeBackend: RendererBackend;
  readonly error?: string;
}
