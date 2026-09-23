import { DASHBOARD_VIDEO_AUDIO_BLOCKED_CAPABILITIES, DASHBOARD_VIDEO_READY_CAPABILITIES,
  DASHBOARD_VIDEO_REQUIRED_CAPABILITIES, bytesToBase64, hasDashboardVideoAudioTrack, probeDashboardVideoMedia,
  type DashboardVideoDiagnosticV1, type DashboardVideoMediaV1 } from "@bim-studio/deep-engine/runtime-package";
import type { DashboardRasterCompileInput } from "./dashboardRasterTypes";

interface NodeBinding {
  readonly nodeId: string;
  readonly runtimeNodeId: string;
}

export function compileDashboardVideoDiagnostics(input: DashboardRasterCompileInput, bindings: readonly NodeBinding[]): {
  readonly videos: DashboardVideoDiagnosticV1[];
  readonly media: DashboardVideoMediaV1[];
} {
  const document = input.document;
  const runtimeIds = new Map(bindings.map(binding => [binding.nodeId, binding.runtimeNodeId]));
  const media = new Map<string, DashboardVideoMediaV1>();
  const videos = document.application.pages.flatMap(page => page.nodes.flatMap(node => {
    if (node.kind !== "data-widget" || node.widget.type !== "video") return [];
    const runtimeId = runtimeIds.get(node.id);
    if (!runtimeId) throw new Error(`Video node ${node.id} has no compiled runtime identity`);
    const uri = node.widget.videoUrl?.trim() || null;
    const assetId = input.nodeAssets[node.id]?.video;
    const asset = assetId ? input.assets[assetId] : undefined;
    if (assetId && (!asset || asset.faceIndex !== undefined || node.widget.assetId && node.widget.assetId !== asset.identity.id))
      throw new Error(`Video node ${node.id} has an invalid frozen media binding`);
    let resourceId: string | null = null;
    if (asset) {
      const format = probeDashboardVideoMedia(asset.bytes, asset.mime);
      resourceId = `media.${asset.sha256}`;
      const item: DashboardVideoMediaV1 = { id: resourceId, revision: 1, format,
        mime: "video/mp4", byteLength: asset.bytes.byteLength, sha256: asset.sha256, dataBase64: bytesToBase64(asset.bytes) };
      const existing = media.get(resourceId);
      if (existing && (existing.byteLength !== item.byteLength || existing.dataBase64 !== item.dataBase64))
        throw new Error("Content-addressed video media identity collision");
      media.set(resourceId, item);
    }
    const autoplay = node.widget.videoAutoplay !== false, muted = node.widget.videoMuted !== false;
    const audioReady = Boolean(asset && hasDashboardVideoAudioTrack(asset.bytes));
    const state = resourceId && (muted || audioReady)
      ? { status: "ready" as const, transport: autoplay ? "autoplay" as const : "poster" as const,
          positionSeconds: 0 as const, durationSeconds: null, reason: "native-video-runtime-ready" as const,
          missingCapabilities: DASHBOARD_VIDEO_READY_CAPABILITIES }
      : resourceId
        ? { status: "blocked" as const, transport: "unavailable" as const, positionSeconds: 0 as const,
            durationSeconds: null, reason: "native-video-audio-unavailable" as const,
            missingCapabilities: DASHBOARD_VIDEO_AUDIO_BLOCKED_CAPABILITIES }
      : { status: "blocked" as const, transport: "unavailable" as const, positionSeconds: 0 as const,
            durationSeconds: null, reason: uri === null ? "source-missing" as const : "native-video-runtime-unavailable" as const,
            missingCapabilities: DASHBOARD_VIDEO_REQUIRED_CAPABILITIES };
    return [{ nodeId: runtimeId, sourceNodeId: node.id,
      source: { uri, availability: resourceId ? "packaged" as const : uri === null ? "missing" as const : "external-unresolved" as const,
        packaged: Boolean(resourceId), resourceId },
      playback: { fit: node.widget.videoFit ?? "cover", autoplay, muted, loop: node.widget.videoLoop !== false }, state }];
  }));
  return { videos, media: [...media.values()].sort((left, right) => left.id.localeCompare(right.id)) };
}
