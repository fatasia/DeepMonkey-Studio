import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializeSceneViewerDelivery,
  resetSceneViewerDeliveryForTest,
  sceneViewerDeliveryFetch,
  sceneViewerDeliveryRendererMode,
  sceneViewerDeliveryRoute,
  sceneViewerDeliveryToolbarVisible,
} from "./sceneViewerDelivery";

let markerContent: string | undefined;
let staticRoute = false;

beforeEach(() => {
  markerContent = undefined;
  staticRoute = false;
  const location = { href: "https://viewer.test/", pathname: "/", search: "", hash: "" };
  vi.stubGlobal("window", {
    location,
    history: {
      replaceState: (_state: unknown, _title: string, target: string) => {
        const parsed = new URL(target, location.href);
        Object.assign(location, { href: parsed.href, pathname: parsed.pathname, search: parsed.search, hash: parsed.hash });
      },
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    querySelector: (selector: string) => selector.includes('"scene-viewer-route"')
      ? staticRoute ? { content: "static" } : null
      : markerContent ? { content: markerContent } : null,
    documentElement: { dataset: {} },
  });
});

afterEach(() => {
  resetSceneViewerDeliveryForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("scene viewer delivery runtime", () => {
  it("locks the route and serves only the bundled read-only API contract", async () => {
    markerContent = "/delivery/scene-viewer.json";
    await initializeSceneViewerDelivery(async () => manifest());

    expect(sceneViewerDeliveryRoute()).toEqual({ view: "published", sceneId: "scene-1" });
    expect(sceneViewerDeliveryRendererMode()).toBe("webgpu-preferred");
    expect(sceneViewerDeliveryToolbarVisible()).toBe(false);
    expect(window.location.pathname).toBe("/published/scene-1");
    const browse = await sceneViewerDeliveryFetch("https://scene-viewer.invalid/api/public/scenes/scene-1/browse");
    expect(await browse.json()).toMatchObject({ publication: { sceneId: "scene-1" }, project: { id: "project-1" } });
    const write = await sceneViewerDeliveryFetch("https://scene-viewer.invalid/api/projects/project-1", { method: "PATCH" });
    expect(write.status).toBe(405);
  });

  it("does not activate without the publisher marker", async () => {
    expect(await initializeSceneViewerDelivery(async () => manifest())).toBeUndefined();
    expect(sceneViewerDeliveryRoute()).toBeUndefined();
  });

  it("keeps the publisher's static index URL and readonly API on a repository subpath", async () => {
    markerContent = "./delivery/scene-viewer.json";
    staticRoute = true;
    Object.assign(window.location, { href: "https://viewer.test/DeepMonkey-Studio/browse/", pathname: "/DeepMonkey-Studio/browse/" });
    let requested: URL | undefined;
    await initializeSceneViewerDelivery(async url => { requested = url; return manifest(); });
    expect(requested?.pathname).toBe("/DeepMonkey-Studio/browse/delivery/scene-viewer.json");
    expect(window.location.pathname).toBe("/DeepMonkey-Studio/browse/");
    expect((await sceneViewerDeliveryFetch("/api/projects/project-1", { method: "PATCH" })).status).toBe(405);
  });
});

function manifest() {
  const publishedAt = "2026-08-31T08:00:00.000Z";
  return {
    kind: "industrial-studio-scene-viewer",
    schemaVersion: 1,
    deliveryTarget: "windows-scene-viewer",
    packageId: "fixture",
    createdAt: publishedAt,
    publishedAt,
    rendererMode: "webgpu-preferred",
    toolbarVisible: false,
    sourcePublicationSha256: "SOURCE",
    publicationSha256: "PUBLICATION",
    projectSha256: "PROJECT",
    publication: {
      sceneId: "scene-1",
      projectId: "project-1",
      name: "工作站",
      publishedAt,
      snapshot: { id: "scene-1", projectId: "project-1", name: "工作站", schemaVersion: 1, publicationMode: "cloud", models: [], primitives: [], measurements: [], objects: [], layers: [], settings: {}, camera: {}, createdAt: publishedAt, updatedAt: publishedAt },
    },
    project: { id: "project-1", name: "工厂", description: "", models: [], createdAt: publishedAt, updatedAt: publishedAt },
    branding: { systemName: "DeepMonkey Studio", browserTitle: "工作站", loginSubtitle: "", copyright: "", logoUrl: "/brand/logo-industrial.svg", iconUrl: "/brand/app-icon-industrial.svg", primaryColor: "#d6aa4d", themeMode: "dark", defaultLocale: "zh-CN", defaultEntry: "manager", defaultSceneBackground: "#202a31", defaultGridVisible: true, maintenanceEnabled: false, maintenanceMessage: "" },
    assets: [],
  };
}
