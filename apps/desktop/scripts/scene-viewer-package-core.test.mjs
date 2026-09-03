import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  assertSceneViewerViteManifest,
  createSceneViewerPayload,
  injectDeliveryMarker,
  pruneSceneViewerFrontend,
  resolveSceneViewerBuildPaths,
  sceneViewerWebBuildEnvironment,
  validateSource,
} from "./scene-viewer-package-core.mjs";

test("isolates generated viewer output from the regular Web dist", () => {
  const desktop = path.join(tmpdir(), "studio", "apps", "desktop");
  const paths = resolveSceneViewerBuildPaths(desktop, "scene-release-1");
  assert.equal(paths.buildRoot, path.join(desktop, ".scene-viewer-build", "scene-release-1"));
  assert.equal(paths.webDist, path.join(paths.buildRoot, "web-dist"));
  assert.equal(paths.frontendDirectory, path.join(paths.buildRoot, "frontend"));
  assert.notEqual(paths.webDist, path.resolve(desktop, "../web/dist"));
  assert.deepEqual(sceneViewerWebBuildEnvironment(paths.webDist), {
    VITE_SCENE_VIEWER_BUILD: "true",
    VITE_SCENE_VIEWER_OUT_DIR: path.resolve(paths.webDist),
  });
});

test("preserves an explicit Web dist input and rejects cleanup path traversal", () => {
  const desktop = path.join(tmpdir(), "studio", "apps", "desktop");
  const workingDirectory = path.join(tmpdir(), "release-input");
  const paths = resolveSceneViewerBuildPaths(desktop, "scene-release-2", "prepared-dist", workingDirectory);
  assert.equal(paths.webDist, path.join(workingDirectory, "prepared-dist"));
  assert.throws(() => resolveSceneViewerBuildPaths(desktop, "../outside"), /package-id/);
  assert.throws(
    () => resolveSceneViewerBuildPaths(desktop, "scene-release-2", paths.generatedWebDist),
    /不能位于当前只读包的清理目录/,
  );
});

test("freezes one publication and rewrites only its required project resources", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/robot.glb") {
      response.setHeader("content-type", "model/gltf-binary");
      response.end(Buffer.from("real-binary-placeholder-for-contract-test"));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const apiOrigin = `http://127.0.0.1:${address.port}`;
  const source = fixture(`${apiOrigin}/robot.glb`);
  const original = structuredClone(source);
  try {
    const payload = await createSceneViewerPayload(source, {
      apiOrigin,
      packageId: "fixture-package",
      renderer: "published",
      toolbar: "hide",
    });
    assert.deepEqual(source, original, "packager must not mutate the frozen source publication");
    assert.equal(payload.manifest.deliveryTarget, "windows-scene-viewer");
    assert.equal(payload.manifest.rendererMode, "webgpu-preferred");
    assert.equal(payload.manifest.toolbarVisible, false);
    assert.match(payload.manifest.project.models[0].manifest.geometryUrl, /^\/delivery\/assets\//);
    assert.equal(payload.manifest.project.dataConnections, undefined);
    assert.equal(payload.manifest.assets.length, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("rejects a different publication timestamp and injects an explicit runtime marker", () => {
  const source = fixture("https://example.test/robot.glb");
  assert.throws(
    () => validateSource(source.publication, source.project, { publishedAt: "2026-08-31T09:00:00.000Z" }),
    /指定发布时间/,
  );
  assert.match(injectDeliveryMarker("<html><head></head><body></body></html>"), /scene-viewer-delivery/);
});

test("rejects an editor dist before packaging", () => {
  assert.doesNotThrow(() => assertSceneViewerViteManifest({
    "src/delivery/SceneViewerRoot.tsx": { file: "assets/viewer.js" },
  }));
  assert.throws(() => assertSceneViewerViteManifest({
    "src/delivery/SceneViewerRoot.tsx": { file: "assets/viewer.js" },
    "src/App.tsx": { file: "assets/editor.js" },
  }), /编辑器入口/);
});

test("prunes optional runtimes and stale brand files from a primitive-only client", async () => {
  const frontend = await mkdtemp(path.join(tmpdir(), "bim-studio-scene-viewer-prune-"));
  const files = {
    "assets/core.js": "core",
    "assets/rapier.js": "physics",
    "assets/fragments.js": "fragments",
    "brand/app-icon-industrial.svg": "<svg/>",
    "brand/logo-industrial.svg": "<svg/>",
    "brand/backups/old.png": "old",
    "wasm/web-ifc.wasm": "wasm",
    "draco/decoder.wasm": "draco",
    "downloads/old.zip": "download",
    "showcase/old.svg": "showcase",
  };
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(frontend, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const viteManifest = {
    "src/delivery/SceneViewerRoot.tsx": { file: "assets/core.js", dynamicImports: ["rapier", "fragments"] },
    rapier: { file: "assets/rapier.js" },
    fragments: { file: "assets/fragments.js" },
  };
  const deliveryManifest = {
    publication: { snapshot: { models: [], primitives: [{ id: "box", kind: "box" }] } },
    project: { models: [] },
    branding: { logoUrl: "/brand/logo-industrial.svg", iconUrl: "/brand/app-icon-industrial.svg" },
  };
  try {
    // Use production manifest identifiers so the optional runtime matcher sees them.
    viteManifest["../../node_modules/@dimforge+rapier3d-compat/rapier.mjs"] = viteManifest.rapier;
    viteManifest["../../node_modules/@thatopen/fragments/dist/index.mjs"] = viteManifest.fragments;
    delete viteManifest.rapier;
    delete viteManifest.fragments;
    viteManifest["src/delivery/SceneViewerRoot.tsx"].dynamicImports = Object.keys(viteManifest).slice(1);
    const result = await pruneSceneViewerFrontend(frontend, deliveryManifest, viteManifest);
    assert.deepEqual(result.removedPublicRoots.sort(), ["downloads", "draco", "showcase", "wasm"]);
    assert.equal(await readFile(path.join(frontend, "assets/core.js"), "utf8"), "core");
    await assert.rejects(() => readFile(path.join(frontend, "assets/rapier.js")), /ENOENT/);
    await assert.rejects(() => readFile(path.join(frontend, "assets/fragments.js")), /ENOENT/);
    await assert.rejects(() => readFile(path.join(frontend, "brand/backups/old.png")), /ENOENT/);
    assert.equal(await readFile(path.join(frontend, "brand/logo-industrial.svg"), "utf8"), "<svg/>");
    assert.deepEqual(viteManifest["src/delivery/SceneViewerRoot.tsx"].dynamicImports, []);
  } finally {
    await rm(frontend, { recursive: true, force: true });
  }
});

test("keeps model and physics runtimes required by the frozen publication", async () => {
  const frontend = await mkdtemp(path.join(tmpdir(), "bim-studio-scene-viewer-keep-"));
  const files = [
    "assets/core.js",
    "assets/rapier.js",
    "assets/fragments.js",
    "brand/app-icon-industrial.svg",
    "brand/logo-industrial.svg",
    "wasm/web-ifc.wasm",
    "draco/decoder.wasm",
  ];
  for (const name of files) {
    const target = path.join(frontend, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, name);
  }
  const rapierKey = "../../node_modules/@dimforge+rapier3d-compat/rapier.mjs";
  const fragmentsKey = "../../node_modules/@thatopen/fragments/dist/index.mjs";
  const viteManifest = {
    "src/delivery/SceneViewerRoot.tsx": { file: "assets/core.js", dynamicImports: [rapierKey, fragmentsKey] },
    [rapierKey]: { file: "assets/rapier.js" },
    [fragmentsKey]: { file: "assets/fragments.js" },
  };
  const deliveryManifest = {
    publication: { snapshot: { physics: { enabled: true }, models: [{ modelId: "ifc" }, { modelId: "glb" }], primitives: [] } },
    project: { models: [{ manifest: { viewerKind: "fragments" } }, { manifest: { viewerKind: "gltf" } }] },
    branding: { logoUrl: "/brand/logo-industrial.svg", iconUrl: "/brand/app-icon-industrial.svg" },
  };
  try {
    const result = await pruneSceneViewerFrontend(frontend, deliveryManifest, viteManifest);
    assert.deepEqual(result.removedRuntimeEntries, []);
    assert.deepEqual(result.removedPublicRoots, ["downloads", "showcase"]);
    for (const name of ["assets/rapier.js", "assets/fragments.js", "wasm/web-ifc.wasm", "draco/decoder.wasm"]) {
      assert.equal(await readFile(path.join(frontend, name), "utf8"), name);
    }
    assert.deepEqual(viteManifest["src/delivery/SceneViewerRoot.tsx"].dynamicImports, [rapierKey, fragmentsKey]);
  } finally {
    await rm(frontend, { recursive: true, force: true });
  }
});

test("stops a stalled packaged asset download at the configured deadline", async () => {
  const server = createServer((_request, _response) => undefined);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const apiOrigin = `http://127.0.0.1:${address.port}`;
  try {
    await assert.rejects(
      () => createSceneViewerPayload(fixture(`${apiOrigin}/stalled.glb`), {
        apiOrigin,
        packageId: "timeout-fixture",
        renderer: "published",
        toolbar: "published",
        resourceTimeoutMs: 20,
      }),
      /下载资源超时/,
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function fixture(geometryUrl) {
  const publishedAt = "2026-08-31T08:00:00.000Z";
  const publication = {
    sceneId: "scene-1",
    projectId: "project-1",
    name: "机器人工作站",
    publishedAt,
    snapshot: {
      id: "scene-1",
      projectId: "project-1",
      name: "机器人工作站",
      schemaVersion: 1,
      publicationMode: "cloud",
      publicationToolbarVisible: true,
      models: [{ modelId: "model-1", name: "机器人", visible: true }],
      primitives: [],
      measurements: [],
      objects: [],
      layers: [],
      settings: {},
      camera: { position: { x: 4, y: 3, z: 5 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
      createdAt: publishedAt,
      updatedAt: publishedAt,
      publishedAt,
    },
  };
  return {
    publication,
    project: {
      id: "project-1",
      name: "工厂",
      description: "",
      models: [{
        id: "model-1",
        projectId: "project-1",
        name: "机器人",
        format: "glb",
        size: 39,
        status: "ready",
        progress: 100,
        message: "",
        sourceUrl: geometryUrl,
        manifest: { schemaVersion: 1, modelId: "model-1", sourceName: "机器人", sourceFormat: "glb", viewerKind: "gltf", geometryUrl, createdAt: publishedAt },
        createdAt: publishedAt,
        updatedAt: publishedAt,
      }],
      dataConnections: [{ id: "private-connector" }],
      createdAt: publishedAt,
      updatedAt: publishedAt,
    },
  };
}
