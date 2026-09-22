export const DASHBOARD_VIDEO_REQUIRED_CAPABILITIES = [
  "video-decoder",
  "frame-texture-update",
  "media-clock",
  "playback-controls",
  "seek",
] as const;
export const DASHBOARD_VIDEO_READY_CAPABILITIES = [] as const;
export const DASHBOARD_VIDEO_AUDIO_BLOCKED_CAPABILITIES = ["audio-output"] as const;

export type DashboardVideoCapabilityV1 = typeof DASHBOARD_VIDEO_REQUIRED_CAPABILITIES[number] | "audio-output";

export interface DashboardVideoMediaV1 {
  readonly id: string;
  readonly revision: number;
  readonly format: "mp4-isobmff";
  readonly mime: "video/mp4";
  readonly byteLength: number;
  readonly sha256: string;
  readonly dataBase64: string;
}

/**
 * Native capability contract. Packaged, muted media supports playback,
 * keyboard/pointer controls and bounded seek. Audio remains fail-closed.
 */
export interface DashboardVideoDiagnosticV1 {
  readonly nodeId: string;
  readonly sourceNodeId: string;
  readonly source: {
    readonly uri: string | null;
    readonly availability: "missing" | "external-unresolved" | "packaged";
    readonly packaged: boolean;
    readonly resourceId: string | null;
  };
  readonly playback: {
    readonly fit: "cover" | "contain" | "fill";
    readonly autoplay: boolean;
    readonly muted: boolean;
    readonly loop: boolean;
  };
  readonly state: {
    readonly status: "blocked" | "ready";
    readonly transport: "unavailable" | "autoplay" | "poster";
    readonly positionSeconds: 0;
    readonly durationSeconds: null;
    readonly reason: "source-missing" | "native-video-runtime-unavailable" | "native-video-runtime-ready" | "native-video-audio-unavailable";
    readonly missingCapabilities: readonly DashboardVideoCapabilityV1[];
  };
}
