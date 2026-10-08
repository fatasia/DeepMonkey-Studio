import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OntologyPackage, OntologyPublishContext } from "@bim-studio/contracts";
import { newOntologyPackage } from "@bim-studio/contracts";
import { MAX_ONTOLOGY_SNAPSHOTS, OntologyPackageStore } from "./ontologyStore.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

let lastRoot = "";

async function createStore(options: { maxSnapshots?: number } = {}): Promise<OntologyPackageStore> {
  const directory = await mkdtemp(path.join(tmpdir(), "ontology-store-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new OntologyPackageStore(directory, { maxSnapshots: options.maxSnapshots });
  await store.init();
  lastRoot = path.join(directory, "ontology");
  return store;
}

function documentPath(): string {
  return path.join(lastRoot, "project-1", "packages.json");
}

/** 组装一个能通过九条门禁的最小包（与 contracts 测试同构）。 */
export function buildPublishablePackage(id = "pkg-1"): OntologyPackage {
  const pkg = newOntologyPackage("manufacturing", "alice", "2026-09-29T08:00:00.000Z");
  pkg.id = id;
  pkg.name = "产线设备本体";
  pkg.objects = [
    {
      id: "o1", key: "Device", label: "设备", domain: "manufacturing",
      primaryKeys: ["device_id"],
      properties: [{ key: "device_id", label: "设备编号", type: "string", confirmed: true }],
      sourceBindings: [{ kind: "dataset", sourceId: "ds-devices", fieldMappings: [{ propertyKey: "device_id", fieldKey: "device_id" }], schemaFingerprint: "fp-1" }],
      aliases: [], identityMappings: [], status: "review", version: 1, owner: "alice",
    },
    {
      id: "o2", key: "Event", label: "维护事件", domain: "manufacturing",
      primaryKeys: ["event_id"],
      properties: [{ key: "event_id", label: "事件编号", type: "string", confirmed: true }],
      sourceBindings: [{ kind: "manual", sourceId: "manual-1", fieldMappings: [{ propertyKey: "event_id", fieldKey: "event_id" }], note: "人工登记" }],
      aliases: [], identityMappings: [], status: "review", version: 1, owner: "alice",
    },
  ];
  pkg.relations = [
    {
      id: "r1", key: "device_triggers_event", label: "设备触发事件",
      sourceObject: "Device", targetObject: "Event",
      cardinality: "one-to-many", direction: "directed", properties: [],
      keyMapping: { sourceField: "device_id", targetField: "event_id" },
      source: { kind: "dataset", sourceId: "ds-devices", note: "工单外键印证" },
      evidence: [{ source: "ds-devices 抽样", recordedAt: "2026-09-29T08:00:00.000Z" }],
      status: "review", version: 1,
    },
  ];
  pkg.actions = [
    {
      id: "a1", key: "diagnose_device", label: "设备诊断", boundObject: "Device",
      inputSchema: { type: "object", properties: { deviceId: { type: "string" } } },
      outputSchema: { type: "object", properties: { report: { type: "string" } } },
      toolBinding: { kind: "capability", id: "cap.diagnosis", version: "1.0.0" },
      preconditions: [], effect: "read", riskLevel: "low",
      approvalRequired: false, idempotencyRequired: false,
      impactScope: ["Device"], authorizedScopes: ["project:read"],
      evidenceRequired: true, status: "review", version: 1,
    },
  ];
  pkg.goldenQuestions = [{ id: "q1", question: "设备 press-07 关联工单", passed: true, passedAt: "2026-09-29T08:00:00.000Z" }];
  pkg.evidence = [{ source: "ds-devices", fingerprint: "abc", recordedAt: "2026-09-29T08:00:00.000Z" }];
  pkg.impactReviewed = true;
  pkg.impactReviewedBy = "bob";
  return pkg;
}

export function publishableContext(): OntologyPublishContext {
  return {
    capabilities: [{ id: "cap.diagnosis", version: "1.0.0", kind: "query" }],
    datasetSchemas: { "ds-devices": "fp-1" },
  };
}

describe("OntologyPackageStore（原子写 + 版本纪律）", () => {
  it("rejects a stale graph relation edit without losing a newer saved package", async () => {
    const store = await createStore();
    const first = await store.createPackage("project-1", buildPublishablePackage());
    const latest = await store.savePackageDraft("project-1", { ...first, name: "新设备本体" });
    await expect(store.savePackageDraft("project-1", { ...first, name: "过期图谱" })).rejects.toMatchObject({ code: "conflict" });
    expect(await store.getPackage("project-1", first.id)).toEqual(latest);
  });
  it("并发创建互不丢失（链内串行读改写回归）", async () => {
    const store = await createStore();
    const base = buildPublishablePackage();
    await Promise.all(Array.from({ length: 5 }, (_, index) => {
      const pkg = structuredClone(base);
      pkg.id = `pkg-${index}`;
      pkg.name = `本体包 ${index}`;
      return store.createPackage("project-1", pkg, "alice");
    }));
    expect(await store.listPackages("project-1")).toHaveLength(5);
  });

  it("创建即 draft/revision=1；保存草稿 revision 递增；published 拒绝直接改", async () => {
    const store = await createStore();
    const created = await store.createPackage("project-1", buildPublishablePackage(), "alice");
    expect(created.status).toBe("draft");
    expect(created.revision).toBe(1);
    expect(created.version).toBe(0);

    const edited = await store.savePackageDraft("project-1", { ...structuredClone(created), name: "改名" });
    expect(edited.revision).toBe(2);
    expect(edited.name).toBe("改名");

    await store.transitionStatus("project-1", created.id, "review", "alice");
    const published = await store.publishPackage("project-1", created.id, "alice", publishableContext());
    expect(published.status).toBe("published");
    expect(published.version).toBe(1);
    await expect(store.savePackageDraft("project-1", structuredClone(published))).rejects.toMatchObject({ code: "conflict" });
  });

  it("发布必须走九条门禁：ctx 无能力目录时 fail-closed 拒绝且不留半发布状态", async () => {
    const store = await createStore();
    const created = await store.createPackage("project-1", buildPublishablePackage(), "alice");
    await store.transitionStatus("project-1", created.id, "review", "alice");
    await expect(store.publishPackage("project-1", created.id, "alice", {})).rejects.toMatchObject({ code: "gate-failed" });
    const after = await store.getPackage("project-1", created.id);
    expect(after.status).toBe("review");
    expect(after.version).toBe(0);
  });

  it("draft 不能直接发布（必须先提交评审）", async () => {
    const store = await createStore();
    const created = await store.createPackage("project-1", buildPublishablePackage(), "alice");
    await expect(store.publishPackage("project-1", created.id, "alice", publishableContext())).rejects.toMatchObject({ code: "invalid" });
  });

  it("发布生成快照与 history；回滚恢复旧版本并记录 from/to", async () => {
    const store = await createStore();
    const created = await store.createPackage("project-1", buildPublishablePackage(), "alice");
    await store.transitionStatus("project-1", created.id, "review", "alice");
    await store.publishPackage("project-1", created.id, "alice", publishableContext());

    const draft2 = await store.cloneAsDraft("project-1", created.id, "alice");
    draft2.objects[0]!.label = "设备 v2";
    await store.savePackageDraft("project-1", draft2);
    await store.transitionStatus("project-1", created.id, "review", "alice");
    await store.publishPackage("project-1", created.id, "alice", publishableContext());

    const snapshots = await store.getSnapshots("project-1", created.id);
    expect(snapshots.map((item) => item.version)).toEqual([2, 1]);

    const rolled = await store.rollbackToSnapshot("project-1", created.id, snapshots[1]!.snapshotId, "bob");
    expect(rolled.version).toBe(1);
    expect(rolled.objects[0]!.label).toBe("设备");
    const rollback = (await store.getHistory("project-1", created.id)).find((item) => item.action === "rollback");
    expect(rollback).toMatchObject({ fromVersion: 2, toVersion: 1, by: "bob" });
  });

  it("快照上限 FIFO 淘汰最旧", async () => {
    const store = await createStore({ maxSnapshots: 3 });
    const created = await store.createPackage("project-1", buildPublishablePackage(), "alice");
    for (let round = 0; round < 5; round += 1) {
      if (round > 0) {
        const draft = await store.cloneAsDraft("project-1", created.id, "alice");
        await store.savePackageDraft("project-1", draft);
        await store.transitionStatus("project-1", created.id, "review", "alice");
      } else {
        await store.transitionStatus("project-1", created.id, "review", "alice");
      }
      await store.publishPackage("project-1", created.id, "alice", publishableContext());
    }
    const snapshots = await store.getSnapshots("project-1", created.id);
    expect(snapshots.map((item) => item.version)).toEqual([5, 4, 3]);
    expect(MAX_ONTOLOGY_SNAPSHOTS).toBe(20);
  });

  it("状态机：review 驳回回 draft 可走；review→retired 被拒；published→retired 可走", async () => {
    const store = await createStore();
    const created = await store.createPackage("project-1", buildPublishablePackage(), "alice");
    await store.transitionStatus("project-1", created.id, "review", "alice");
    await store.transitionStatus("project-1", created.id, "draft", "alice", "驳回");
    expect((await store.getPackage("project-1", created.id)).status).toBe("draft");
    // draft → retired 不在邻接表内
    await expect(store.transitionStatus("project-1", created.id, "retired", "alice")).rejects.toMatchObject({ code: "invalid" });

    await store.transitionStatus("project-1", created.id, "review", "alice");
    await store.publishPackage("project-1", created.id, "alice", publishableContext());
    const retired = await store.transitionStatus("project-1", created.id, "retired", "alice");
    expect(retired.status).toBe("retired");
    await expect(store.transitionStatus("project-1", created.id, "draft", "alice")).rejects.toMatchObject({ code: "invalid" });
  });

  it("已发布包不能删除；draft 可删除", async () => {
    const store = await createStore();
    const created = await store.createPackage("project-1", buildPublishablePackage(), "alice");
    await expect(store.deletePackage("project-1", created.id)).resolves.toBe(true);

    const published = await store.createPackage("project-1", { ...buildPublishablePackage("pkg-2"), name: "第二包" }, "alice");
    await store.transitionStatus("project-1", published.id, "review", "alice");
    await store.publishPackage("project-1", published.id, "alice", publishableContext());
    await expect(store.deletePackage("project-1", published.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("磁盘坏条目 fail-closed 过滤：坏记录被丢弃，好记录保留", async () => {
    const store = await createStore();
    await store.createPackage("project-1", buildPublishablePackage(), "alice");
    await store.createPackage("project-1", { ...buildPublishablePackage("pkg-2"), name: "第二包" }, "alice");
    // 绕过 API 直接污染磁盘文档
    const raw = JSON.parse(await readFile(documentPath(), "utf8"));
    raw.records.push({ current: { schemaVersion: 1 }, snapshots: "not-an-array", history: null });
    raw.records.push(null);
    await writeFile(documentPath(), JSON.stringify(raw), "utf8");
    // 新实例绕过内存缓存重读
    const freshRootParent = path.dirname(lastRoot);
    const fresh = new OntologyPackageStore(freshRootParent);
    await fresh.init();
    const list = await fresh.listPackages("project-1");
    expect(list.map((item) => item.id)).toEqual(["pkg-1", "pkg-2"]);
  });

  it("名称/id 冲突 409；新实例可从磁盘重读（持久化生效）", async () => {
    const store = await createStore();
    await store.createPackage("project-1", buildPublishablePackage("pkg-a"), "alice");
    await expect(store.createPackage("project-1", { ...buildPublishablePackage("pkg-b"), name: "产线设备本体" }, "alice")).rejects.toMatchObject({ code: "conflict" });
    await expect(store.createPackage("project-1", buildPublishablePackage("pkg-a"), "alice")).rejects.toMatchObject({ code: "conflict" });

    const fresh = new OntologyPackageStore(path.dirname(lastRoot));
    await fresh.init();
    const list = await fresh.listPackages("project-1");
    expect(list[0]!.name).toBe("产线设备本体");
    expect(JSON.parse(await readFile(documentPath(), "utf8")).schemaVersion).toBe(1);
  });
});
