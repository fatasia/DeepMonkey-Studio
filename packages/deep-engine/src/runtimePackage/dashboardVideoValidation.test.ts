import { expect, it } from "vitest";
import { validateDeepRuntimePackage } from "./validation.js";
import { draft, rehash, root, type Mutable } from "./dashboardComposition.testUtils.js";
import type { DashboardVideoDiagnosticV1 } from "./dashboardVideoTypes.js";
import type { DeepRuntimePackageV5 } from "./types.js";

function packageWithVideo(): Mutable<DeepRuntimePackageV5> {
  const value = draft(), dashboard = root(value), nodeId = dashboard.pages[0]!.nodes[0]!.id;
  dashboard.videos = [{ nodeId, sourceNodeId: "author-video",
    source: { uri: "/media/inspection.mp4", availability: "external-unresolved", packaged: false, resourceId: null },
    playback: { fit: "contain", autoplay: false, muted: true, loop: false },
    state: { status: "blocked", transport: "unavailable", positionSeconds: 0, durationSeconds: null,
      reason: "native-video-runtime-unavailable",
      missingCapabilities: ["video-decoder", "frame-texture-update", "media-clock", "playback-controls", "seek"] } }];
  rehash(value);
  return value;
}

it("accepts an explicit diagnostic-only video contract", () => {
  expect(validateDeepRuntimePackage(packageWithVideo()).valid).toBe(true);
});

it("accepts content-addressed MP4 bytes with only autoplay transport enabled", () => {
  const value = packageWithVideo(), dashboard = root(value);
  const sha = "754ed2f212d495ae30ef2f68f8ab18b0ab162ce669f768373d79f72f1ba3c3bd";
  dashboard.media = [{ id: `media.${sha}`, revision: 1, format: "mp4-isobmff", mime: "video/mp4",
    byteLength: 24, sha256: sha, dataBase64: "AAAAGGZ0eXBpc29tAAAAAGlzb21tcDQy" }];
  dashboard.videos![0]!.source = { uri: "/media/inspection.mp4", availability: "packaged", packaged: true,
    resourceId: `media.${sha}` };
  dashboard.videos![0]!.state = { status: "ready", transport: "poster", positionSeconds: 0,
    durationSeconds: null, reason: "native-video-runtime-ready", missingCapabilities: [] };
  rehash(value);
  expect(validateDeepRuntimePackage(value).valid).toBe(true);
  dashboard.media[0]!.dataBase64 = "AAAAGGZ0eXBpc29tAAAAAGlzb21tcDQz";
  rehash(value);
  expect(validateDeepRuntimePackage(value).valid).toBe(false);
});

it.each([
  ["packaged media", (video: Mutable<DashboardVideoDiagnosticV1>) => { video.source.packaged = true; }],
  ["playable state", (video: Mutable<DashboardVideoDiagnosticV1>) => { video.state.status = "ready"; }],
  ["missing decoder diagnostic", (video: Mutable<DashboardVideoDiagnosticV1>) => { video.state.missingCapabilities.shift(); }],
  ["foreign node", (video: Mutable<DashboardVideoDiagnosticV1>) => { video.nodeId = `node.${"f".repeat(64)}`; }],
] as const)("rejects video diagnostics that claim %s", (_name, edit) => {
  const value = packageWithVideo(), video = root(value).videos![0]!;
  edit(video); rehash(value);
  expect(validateDeepRuntimePackage(value).valid).toBe(false);
});
