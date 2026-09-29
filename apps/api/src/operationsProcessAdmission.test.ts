import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PprBopVersionDraft, PlantLiteStudyRequest } from "@bim-studio/contracts";
import { fingerprint64 } from "@bim-studio/contracts";
import { createAgvLinePlantLiteModel } from "@bim-studio/plant-lite-simulation";
import { OperationsService } from "./operations.js";
import { registerOperationsRoutes } from "./operationsRoutes.js";
import { runPlantLiteStudy } from "./plantLiteStudy.js";
import { createApiServer } from "./serverOptions.js";
import { PprBopService } from "./pprBopService.js";
import { registerPprBopRoutes } from "./pprBopRoutes.js";
import type { FastifyInstance } from "fastify";

/**
 * 结构级正式预测门接入生产路径的闭环测试（C2 接线切片）。
 *
 * 入口：POST /api/projects/:projectId/operations/logistics/des-studies ——
 * 带 pprBinding 的 DES Study 即「拿已保存 BOP 版本跑正式预测」的生产入口
 * （pprBopRoutes 只有 create/list/get/compare/analysis，无预测发起点）。
 * 门语义：草稿版本永远可保存；只有正式预测发起被阻断；阻断与版本命名无关。
 */

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface Harness {
  app: FastifyInstance;
  ppr: PprBopService;
  operations: OperationsService;
}

async function harness(): Promise<Harness> {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-admission-wiring-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const ppr = new PprBopService(directory);
  const operations = new OperationsService(directory, {
    plantLiteExecutor: {
      run: (projectId: string, request: PlantLiteStudyRequest) =>
        Promise.resolve(runPlantLiteStudy(projectId, request, "2026-09-28T10:00:00.000Z")),
    },
  });
  await Promise.all([ppr.init(), operations.init()]);
  const store = { getProject: (id: string) => (id === "project-1" ? { id, models: [] } : undefined) };
  const app = createApiServer();
  cleanups.push(() => app.close());
  await registerPprBopRoutes(app, { store: store as never, service: ppr, operations });
  await registerOperationsRoutes(app, { store: store as never, service: operations, pprBop: ppr });
  return { app, ppr, operations };
}

async function createVersion(ppr: PprBopService, draft: PprBopVersionDraft) {
  return ppr.create("project-1", draft);
}

async function runStudy(app: FastifyInstance, version: { id: string; planId: string }, operationIds: string[]) {
  const model = createAgvLinePlantLiteModel();
  const payload: PlantLiteStudyRequest = {
    name: "绑定 BOP 版本的正式预测",
    model,
    seed: "admission-42",
    replications: 2,
    pprBinding: {
      planId: version.planId,
      versionId: version.id,
      entities: operationIds.map((id) => ({ kind: "operation" as const, id })),
      assets: [],
      sourceModelFingerprint: fingerprint64(model),
    },
  };
  return app.inject({
    method: "POST",
    url: "/api/projects/project-1/operations/logistics/des-studies",
    payload,
  });
}

describe("正式预测入口的结构级准入门（des-studies × BOP 版本）", () => {
  it("AND 汇合版本被正式预测入口拒绝：422 + process-admission-blocked + multiple-predecessors，且不落库不执行仿真", async () => {
    const { app, ppr, operations } = await harness();
    const version = await createVersion(ppr, andJoinDraft());
    expect(version.id).toBeTruthy();

    const response = await runStudy(app, version, ["A", "B", "D"]);
    expect(response.statusCode).toBe(422);
    const body = response.json() as {
      code?: string;
      reasonCodes?: string[];
      message?: string;
      admission?: { formalPredictionAllowed?: boolean; blockingReasonCodes?: string[] };
    };
    expect(body.code).toBe("process-admission-blocked");
    expect(body.reasonCodes).toEqual(["multiple-predecessors"]);
    expect(body.message).toContain("非线性工艺准入阻断");
    expect(body.admission?.formalPredictionAllowed).toBe(false);
    expect(body.admission?.blockingReasonCodes).toEqual(["multiple-predecessors"]);

    // 阻断即拒绝：未执行仿真、未保存任何 Study；版本草稿本身仍在档。
    expect(operations.snapshot("project-1").plantLiteStudies).toHaveLength(0);
    expect(ppr.list("project-1").map((item) => item.id)).toContain(version.id);
  });

  it("线性版本照常通过结构门：正式预测正常执行并保存 Study", async () => {
    const { app, ppr, operations } = await harness();
    const version = await createVersion(ppr, linearDraft());

    const response = await runStudy(app, version, ["A", "B", "C"]);
    expect(response.statusCode).toBe(200);
    const record = response.json() as { id: string; pprBinding?: { versionId: string } };
    expect(record.id).toBeTruthy();
    expect(record.pprBinding?.versionId).toBe(version.id);
    expect(operations.snapshot("project-1").plantLiteStudies).toHaveLength(1);
  });

  it("草稿保存不受结构门影响：AND 汇合版本可创建、可作基线派生新版本，阻断运行后版本档无损", async () => {
    const { app, ppr } = await harness();
    const blocked = await createVersion(ppr, andJoinDraft());
    expect(ppr.list("project-1")).toHaveLength(1);

    await runStudy(app, blocked, ["A", "B", "D"]);

    // 阻断后同计划仍可基于被拒版本派生新草稿——版本只追加纪律与草稿可保存性均不受影响。
    const derived = await createVersion(ppr, { ...andJoinDraft(), basedOnVersionId: blocked.id, name: "重建候选" });
    expect(ppr.list("project-1").map((item) => item.version)).toEqual(["v1", "v2"]);
    expect(derived.basedOnVersionId).toBe(blocked.id);
  });

  it("阻断与命名无关：版本号命名为 -review-only 后缀也无法绕过结构门", async () => {
    const { app, ppr } = await harness();
    const version = await createVersion(ppr, { ...andJoinDraft(), version: "v1-review-only" });
    expect(version.version).toBe("v1-review-only");
    expect(version.version).toContain("-review-only");

    const response = await runStudy(app, version, ["A", "B", "D"]);
    expect(response.statusCode).toBe(422);
    expect((response.json() as { reasonCodes?: string[] }).reasonCodes).toEqual(["multiple-predecessors"]);
  });

  it("不带 pprBinding 的模板 Study 不经过结构门：既有模板预测路径行为不变", async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/operations/logistics/des-studies",
      payload: { name: "模板基线", seed: "template-42", replications: 2 },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { templateId?: string }).templateId).toBe("agv-line-v1");
  });

  it("最小滞后版本在正式预测入口被拒并携带 minimum-lag 理由码：理由码随路由逐类透传", async () => {
    const { app, ppr } = await harness();
    const version = await createVersion(ppr, laggedDraft());

    const response = await runStudy(app, version, ["P", "Q"]);
    expect(response.statusCode).toBe(422);
    const body = response.json() as { code?: string; reasonCodes?: string[] };
    expect(body.code).toBe("process-admission-blocked");
    expect(body.reasonCodes).toEqual(["minimum-lag"]);
  });
});

/** AND 汇合草稿：两件备料汇入同一合装工序（blocked：multiple-predecessors），结构本身是合法草稿。 */
function andJoinDraft(): PprBopVersionDraft {
  return {
    planId: "admission-join-plan",
    name: "合装齐套工艺",
    components: [{ id: "part", name: "零件", kind: "product" }],
    operations: [
      { id: "A", name: "件1备料", standardTimeMinutes: 5, componentRefs: [{ componentId: "part", role: "in-process" }] },
      { id: "B", name: "件2备料", standardTimeMinutes: 5, componentRefs: [{ componentId: "part", role: "in-process" }] },
      { id: "D", name: "合装", standardTimeMinutes: 8, componentRefs: [{ componentId: "part", role: "output" }] },
    ],
    precedenceRelations: [
      { id: "r1", predecessorOperationId: "A", successorOperationId: "D" },
      { id: "r2", predecessorOperationId: "B", successorOperationId: "D" },
    ],
    resources: [{ id: "st", name: "合装工位", kind: "station" }],
    resourceAssignments: [
      { id: "a1", operationId: "A", resourceId: "st" },
      { id: "a2", operationId: "B", resourceId: "st" },
      { id: "a3", operationId: "D", resourceId: "st" },
    ],
  };
}

/** 线性草稿：单前置单后继链 + 单资源占用（direct：sequential-flow），正式预测放行。 */
function linearDraft(): PprBopVersionDraft {
  return {
    planId: "admission-linear-plan",
    name: "线性工艺",
    components: [{ id: "part", name: "零件", kind: "product" }],
    operations: [
      { id: "A", name: "下料", standardTimeMinutes: 5, componentRefs: [{ componentId: "part", role: "in-process" }] },
      { id: "B", name: "加工", standardTimeMinutes: 6, componentRefs: [{ componentId: "part", role: "in-process" }] },
      { id: "C", name: "检验", standardTimeMinutes: 4, componentRefs: [{ componentId: "part", role: "output" }] },
    ],
    precedenceRelations: [
      { id: "r1", predecessorOperationId: "A", successorOperationId: "B" },
      { id: "r2", predecessorOperationId: "B", successorOperationId: "C" },
    ],
    resources: [{ id: "st", name: "工位", kind: "station" }],
    resourceAssignments: [
      { id: "a1", operationId: "A", resourceId: "st" },
      { id: "a2", operationId: "B", resourceId: "st" },
      { id: "a3", operationId: "C", resourceId: "st" },
    ],
  };
}

/** 最小滞后草稿：前置关系要求 5 分钟等待（blocked：minimum-lag）。 */
function laggedDraft(): PprBopVersionDraft {
  return {
    planId: "admission-lag-plan",
    name: "滞后固化工艺",
    components: [{ id: "part", name: "零件", kind: "product" }],
    operations: [
      { id: "P", name: "喷涂", standardTimeMinutes: 5, componentRefs: [{ componentId: "part", role: "in-process" }] },
      { id: "Q", name: "固化后包装", standardTimeMinutes: 4, componentRefs: [{ componentId: "part", role: "output" }] },
    ],
    precedenceRelations: [{ id: "r1", predecessorOperationId: "P", successorOperationId: "Q", minimumLagMinutes: 5 }],
    resources: [{ id: "st", name: "工位", kind: "station" }],
    resourceAssignments: [
      { id: "a1", operationId: "P", resourceId: "st" },
      { id: "a2", operationId: "Q", resourceId: "st" },
    ],
  };
}
