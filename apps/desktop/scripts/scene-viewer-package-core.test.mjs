import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  assertSceneViewerViteManifest,
  createSceneViewerPayload,
  injectDeliveryMarker,
  validateSource,
} from "./scene-viewer-package-core.mjs";

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
