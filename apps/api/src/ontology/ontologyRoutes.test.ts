import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OntologyPackage, SystemUserRecord } from "@bim-studio/contracts";
import { createApiServer } from "../serverOptions.js";
import type { MetadataStore } from "../store.js";
import { datasetSchemaFingerprint } from "./ontologyContext.js";
import { OntologyPackageStore } from "./ontologyStore.js";
import { registerOntologyRoutes } from "./ontologyRoutes.js";
import { buildPublishablePackage, publishableContext } from "./ontologyStore.test.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface Fixture {
  app: Awaited<ReturnType<typeof setupApp>>["app"];
  packageId: string;
}

async function setupApp(user: Partial<SystemUserRecord> | undefined, options: { capabilities?: boolean } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "ontology-routes-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const ontology = new OntologyPackageStore(directory);
  await ontology.init();
  const store = {
    getProject: (projectId: string) => (projectId === "project-1" ? { id: projectId } : undefined),
    listDatasets: (projectId: string) => (projectId === "project-1"
      ? [{ id: "ds-devices", fields: [{ key: "device_id", label: "设备编号", type: "string" }], computedFields: [] }]
      : []),
  };
  const app = createApiServer();
  if (user) app.addHook("preHandler", async (request) => { request.systemUser = user as never; });
  await registerOntologyRoutes(app, {
    store: store as unknown as MetadataStore,
    ontology,
    ...(options.capabilities === false ? {} : { listCapabilities: () => publishableContext().capabilities! }),
  });
  // 种子包直调存储层创建（inject 之后 fastify 已启动，不能再 addHook）。
  const payload = buildPublishablePackage();
  payload.objects[0]!.sourceBindings[0]!.schemaFingerprint = datasetSchemaFingerprint({ fields: [{ key: "device_id", label: "设备编号", type: "string" }], computedFields: [] });
  const seeded = await ontology.createPackage("project-1", payload, "seed");
  return { app, packageId: seeded.id };
}

describe("ontology routes", () => {
  it("CRUD + 评审 + 发布 + 版本 + 回滚全流程", async () => {
    const { app, packageId } = await setupApp({ id: "editor-1", role: "editor" });

    // 未提交评审直接发布 → 400
    expect((await app.inject({ method: "POST", url: `/api/projects/project-1/ontology-packages/${packageId}/publish`, payload: {} })).statusCode).toBe(400);

    // 服务端草稿校验端点：形状通过、门禁带逐条结果
    const validation = await app.inject({ method: "POST", url: "/api/projects/project-1/ontology-packages/validate", payload: buildPublishablePackage(packageId) });
    expect(validation.statusCode).toBe(200);
    expect(validation.json().shapeErrors).toEqual([]);
    expect(validation.json().gate.gates).toHaveLength(9);

    // 保存草稿 → 提交评审 → 发布（保存 payload 保持与服务端一致的数据源指纹）
    const draftPayload = (await app.inject({ method: "GET", url: `/api/projects/project-1/ontology-packages/${packageId}` })).json<OntologyPackage>();
    draftPayload.objects[0]!.sourceBindings[0]!.schemaFingerprint = datasetSchemaFingerprint({ fields: [{ key: "device_id", label: "设备编号", type: "string" }], computedFields: [] });
    const saved = await app.inject({ method: "PUT", url: `/api/projects/project-1/ontology-packages/${packageId}`, payload: { ...draftPayload, name: "产线设备本体 v2" } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().revision).toBe(2);
    expect((await app.inject({ method: "POST", url: `/api/projects/project-1/ontology-packages/${packageId}/submit-review`, payload: {} })).statusCode).toBe(200);
    const published = await app.inject({ method: "POST", url: `/api/projects/project-1/ontology-packages/${packageId}/publish`, payload: {} });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({ status: "published", version: 1 });

    // 版本列表 + 回滚
    const versions = await app.inject({ method: "GET", url: `/api/projects/project-1/ontology-packages/${packageId}/versions` });
    expect(versions.statusCode).toBe(200);
    expect(versions.json().versions).toHaveLength(1);
    expect(versions.json().versions[0].publishedBy).toBe("editor-1");
    const rolled = await app.inject({
      method: "POST",
      url: `/api/projects/project-1/ontology-packages/${packageId}/rollback`,
      payload: { snapshotId: versions.json().versions[0].snapshotId },
    });
    expect(rolled.statusCode).toBe(200);
    expect(rolled.json().version).toBe(1);

    // 发布状态拒绝直接修改；删除被拒；克隆草稿解锁
    expect((await app.inject({ method: "PUT", url: `/api/projects/project-1/ontology-packages/${packageId}`, payload: buildPublishablePackage(packageId) })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/api/projects/project-1/ontology-packages/${packageId}` })).statusCode).toBe(409);
    const clone = await app.inject({ method: "POST", url: `/api/projects/project-1/ontology-packages/${packageId}/clone-draft`, payload: {} });
    expect(clone.statusCode).toBe(200);
    expect(clone.json().status).toBe("draft");

    // 退役需 admin（editor 被拒）
    const retire = await app.inject({ method: "POST", url: `/api/projects/project-1/ontology-packages/${packageId}/retire`, payload: {} });
    expect(retire.statusCode).toBe(403);
    await app.close();
  });

  it("admin 可以退役已发布包", async () => {
    const { app, packageId } = await setupApp({ id: "root", role: "admin" });
    await app.inject({ method: "POST", url: `/api/projects/project-1/ontology-packages/${packageId}/submit-review`, payload: {} });
    expect((await app.inject({ method: "POST", url: `/api/projects/project-1/ontology-packages/${packageId}/publish`, payload: {} })).statusCode).toBe(200);
    const retire = await app.inject({ method: "POST", url: `/api/projects/project-1/ontology-packages/${packageId}/retire`, payload: {} });
    expect(retire.statusCode).toBe(200);
    expect(retire.json().status).toBe("retired");
    await app.close();
  });

  it("发布门禁失败时返回 400 与逐条错误（fail-closed ctx）", async () => {
    const { app, packageId } = await setupApp({ id: "editor-1", role: "editor" }, { capabilities: false });
    await app.inject({ method: "POST", url: `/api/projects/project-1/ontology-packages/${packageId}/submit-review`, payload: {} });
    const failed = await app.inject({ method: "POST", url: `/api/projects/project-1/ontology-packages/${packageId}/publish`, payload: {} });
    expect(failed.statusCode).toBe(400);
    expect(failed.json().message).toContain("fail-closed");
    await app.close();
  });

  it("viewer 写操作 403、只读放行；retire 仅 admin", async () => {
    const { app, packageId } = await setupApp({ id: "watcher", role: "viewer" });
    expect((await app.inject({ method: "GET", url: "/api/projects/project-1/ontology-packages" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/projects/project-1/ontology-packages/${packageId}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/projects/project-1/ontology-packages", payload: buildPublishablePackage("pkg-x") })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: `/api/projects/project-1/ontology-packages/${packageId}`, payload: buildPublishablePackage(packageId) })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/api/projects/project-1/ontology-packages/${packageId}` })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/projects/project-1/ontology-packages/${packageId}/publish`, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/projects/project-1/ontology-packages/${packageId}/rollback`, payload: { snapshotId: "s" } })).statusCode).toBe(403);
    await app.close();

    const editorApp = await setupApp({ id: "editor-2", role: "editor" });
    expect((await editorApp.app.inject({ method: "POST", url: `/api/projects/project-1/ontology-packages/${editorApp.packageId}/retire`, payload: {} })).statusCode).toBe(403);
    await editorApp.app.close();
  });

  it("项目不存在 404；缺失包 404；rollback 缺 snapshotId 400", async () => {
    const { app, packageId } = await setupApp({ id: "editor-1", role: "editor" });
    expect((await app.inject({ method: "GET", url: "/api/projects/other/ontology-packages" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/projects/other/ontology-packages", payload: buildPublishablePackage() })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/projects/project-1/ontology-packages/missing" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/projects/project-1/ontology-packages/${packageId}/rollback`, payload: {} })).statusCode).toBe(400);
    await app.close();
  });
});
