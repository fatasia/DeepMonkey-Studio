import { DASHBOARD_VIDEO_AUDIO_BLOCKED_CAPABILITIES, DASHBOARD_VIDEO_READY_CAPABILITIES,
  DASHBOARD_VIDEO_REQUIRED_CAPABILITIES, type DashboardVideoDiagnosticV1,
  type DashboardVideoMediaV1 } from "./dashboardVideoTypes.js";
import { array, fields, record, requireValue, string } from "./primitives.js";
import type { DashboardRuntimePageV1 } from "./dashboardCompositionTypes.js";

const MAX_SOURCE_BYTES = 2_048;

export function validateDashboardVideos(value: unknown, pages: readonly DashboardRuntimePageV1[],
  media: ReadonlyMap<string, DashboardVideoMediaV1>, path: string): void {
  const videos = array(value, path, 32);
  requireValue(videos.length > 0, path, "Video diagnostics must not be empty.");
  const runtimeNodes = new Set(pages.flatMap(page => page.nodes.map(node => node.id)));
  const runtimeIds = new Set<string>(), sourceIds = new Set<string>();
  for (const [index, candidate] of videos.entries()) {
    const itemPath = `${path}[${index}]`, video = record(candidate, itemPath);
    fields(video, ["nodeId", "sourceNodeId", "source", "playback", "state"], [], itemPath);
    const nodeId = string(video.nodeId, `${itemPath}.nodeId`), sourceNodeId = string(video.sourceNodeId, `${itemPath}.sourceNodeId`);
    requireValue(runtimeNodes.has(nodeId), itemPath, "Video diagnostic node is absent from the dashboard.");
    requireValue(sourceNodeId.length > 0 && new TextEncoder().encode(sourceNodeId).length <= 256
      && !/[\u0000-\u001f\u007f-\u009f]/u.test(sourceNodeId), `${itemPath}.sourceNodeId`, "Invalid author node identity.");
    requireValue(!runtimeIds.has(nodeId) && !sourceIds.has(sourceNodeId), itemPath, "Duplicate video diagnostic identity.");
    runtimeIds.add(nodeId); sourceIds.add(sourceNodeId);

    const source = record(video.source, `${itemPath}.source`);
    fields(source, ["uri", "availability", "packaged", "resourceId"], [], `${itemPath}.source`);
    requireValue(source.uri === null || typeof source.uri === "string", `${itemPath}.source.uri`, "Invalid video source URI.");
    if (typeof source.uri === "string") requireValue(source.uri.length > 0 && new TextEncoder().encode(source.uri).length <= MAX_SOURCE_BYTES
      && !/[\u0000-\u001f\u007f-\u009f]/u.test(source.uri), `${itemPath}.source.uri`, "Invalid video source URI.");
    requireValue(source.resourceId === null || typeof source.resourceId === "string", `${itemPath}.source.resourceId`, "Invalid packaged video resource identity.");
    const packaged = source.packaged === true;
    requireValue(typeof source.packaged === "boolean" && (packaged
      ? source.availability === "packaged" && typeof source.resourceId === "string" && media.has(source.resourceId)
      : source.resourceId === null && source.availability === (source.uri === null ? "missing" : "external-unresolved")),
    `${itemPath}.source`, "Video source availability is inconsistent.");

    const playback = record(video.playback, `${itemPath}.playback`);
    fields(playback, ["fit", "autoplay", "muted", "loop"], [], `${itemPath}.playback`);
    requireValue(["cover", "contain", "fill"].includes(String(playback.fit))
      && [playback.autoplay, playback.muted, playback.loop].every(flag => typeof flag === "boolean"), `${itemPath}.playback`, "Invalid video playback intent.");

    const state = record(video.state, `${itemPath}.state`);
    fields(state, ["status", "transport", "positionSeconds", "durationSeconds", "reason", "missingCapabilities"], [], `${itemPath}.state`);
    const missing = array(state.missingCapabilities, `${itemPath}.state.missingCapabilities`, DASHBOARD_VIDEO_REQUIRED_CAPABILITIES.length);
    const expected = packaged && playback.muted === true
      ? { status: "ready", transport: playback.autoplay === true ? "autoplay" : "poster",
          reason: "native-video-runtime-ready", missing: DASHBOARD_VIDEO_READY_CAPABILITIES }
      : packaged
        ? { status: "blocked", transport: "unavailable", reason: "native-video-audio-unavailable",
            missing: DASHBOARD_VIDEO_AUDIO_BLOCKED_CAPABILITIES }
        : { status: "blocked", transport: "unavailable",
            reason: source.uri === null ? "source-missing" : "native-video-runtime-unavailable",
            missing: DASHBOARD_VIDEO_REQUIRED_CAPABILITIES };
    requireValue(state.status === expected.status && state.transport === expected.transport
      && state.positionSeconds === 0 && state.durationSeconds === null && state.reason === expected.reason,
    `${itemPath}.state`, "Video capability state is inconsistent.");
    requireValue(missing.length === expected.missing.length
      && missing.every((capability, capabilityIndex) => capability === expected.missing[capabilityIndex]),
    `${itemPath}.state.missingCapabilities`, "Video diagnostic capability blockers are inconsistent.");
  }
  const referenced = new Set(videos.map(item => (item as DashboardVideoDiagnosticV1).source.resourceId).filter(Boolean));
  requireValue(referenced.size === media.size && [...media.keys()].every(id => referenced.has(id)), path, "Packaged video media must have a diagnostic owner.");
}

export type { DashboardVideoDiagnosticV1 };
