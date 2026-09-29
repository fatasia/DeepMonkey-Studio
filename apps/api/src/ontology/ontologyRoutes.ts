import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { OntologyPackage } from "@bim-studio/contracts";
import {
  validateOntologyPackageShape,
  validateOntologyPublishGate,
} from "@bim-studio/contracts";
import type { MetadataStore } from "../store.js";
import { buildOntologyPublishContext } from "./ontologyContext.js";
import { OntologyPackageError, type OntologyPackageStore } from "./ontologyStore.js";

interface OntologyRouteDependencies {
  store: MetadataStore;
  ontology: OntologyPackageStore;
  /** 能力目录投影；缺省 = 发布门禁 3 fail-closed（无法验证行动绑定）。 */
  listCapabilities?: () => Array<{ id: string; version: string; kind: string }>;
}

type OntologyPackageBody = Partial<OntologyPackage> | undefined;

/**
 * H-C4-P0 本体包路由：CRUD + 评审流转 + 发布（九条门禁）+ 版本/回滚。
 * 权限：viewer 全部写操作 403；退役（retire）需 admin；其余写操作 editor 及以上。
 * 校验纪律：保存前形状校验；发布前九条门禁（fail-closed，服务端组装真实 ctx）。
 */
export async function registerOntologyRoutes(app: FastifyInstance, dependencies: OntologyRouteDependencies): Promise<void> {
  const { store, ontology, listCapabilities } = dependencies;

  const projectIdOf = (request: FastifyRequest) => (request.params as { projectId: string }).projectId;
  const packageIdOf = (request: FastifyRequest) => (request.params as { packageId: string }).packageId;
  const actorOf = (request: FastifyRequest) => request.systemUser?.id ?? "api-user";
  const rejectOntologyError = (reply: FastifyReply, error: unknown) => {
    if (!(error instanceof OntologyPackageError)) throw error;
    const code = error.code === "not-found" ? 404 : error.code === "conflict" ? 409 : 400;
    return reply.code(code).send({ message: error.message });
  };
  const ensureProject = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!store.getProject(projectIdOf(request))) {
      await reply.code(404).send({ message: "项目不存在" });
      return false;
    }
    return true;
  };
  const requireWriter = (request: FastifyRequest, reply: FastifyReply) => {
    if (request.systemUser?.role === "viewer") {
      void reply.code(403).send({ message: "浏览者不能修改本体包" });
      return false;
    }
    return true;
  };
  const requireAdmin = (request: FastifyRequest, reply: FastifyReply) => {
    if (request.systemUser?.role !== "admin") {
      void reply.code(403).send({ message: "只有管理员可以退役本体包" });
      return false;
    }
    return true;
  };

  app.get("/api/projects/:projectId/ontology-packages", async (request, reply) => {
    if (!await ensureProject(request, reply)) return;
    return ontology.listPackages(projectIdOf(request));
  });

  app.post("/api/projects/:projectId/ontology-packages", async (request, reply) => {
    if (!await ensureProject(request, reply)) return;
    if (!requireWriter(request, reply)) return;
    const body = request.body as OntologyPackageBody;
    if (!body?.name?.trim()) return reply.code(400).send({ message: "本体包名称不能为空" });
    try {
      const created = await ontology.createPackage(projectIdOf(request), {
        ...(body as OntologyPackage),
        id: body.id || randomUUID(),
      }, actorOf(request));
      return reply.code(201).send(created);
    } catch (error) {
      return rejectOntologyError(reply, error);
    }
  });

  /** 草稿校验（不落盘）：形状错误 + 九条门禁逐条结果，供 UI 在保存/发布前反馈。 */
  app.post("/api/projects/:projectId/ontology-packages/validate", async (request, reply) => {
    if (!await ensureProject(request, reply)) return;
    const body = request.body as OntologyPackageBody;
    if (!body) return reply.code(400).send({ message: "缺少本体包内容" });
    const shapeErrors = validateOntologyPackageShape(body as OntologyPackage);
    const gate = validateOntologyPublishGate(body as OntologyPackage, buildOntologyPublishContext(store, projectIdOf(request), listCapabilities));
    return { shapeErrors, gate };
  });

  app.get("/api/projects/:projectId/ontology-packages/:packageId", async (request, reply) => {
    if (!await ensureProject(request, reply)) return;
    try {
      return await ontology.getPackage(projectIdOf(request), packageIdOf(request));
    } catch (error) {
      return rejectOntologyError(reply, error);
    }
  });

  app.put("/api/projects/:projectId/ontology-packages/:packageId", async (request, reply) => {
    if (!await ensureProject(request, reply)) return;
    if (!requireWriter(request, reply)) return;
    const body = request.body as OntologyPackageBody;
    if (!body) return reply.code(400).send({ message: "缺少本体包内容" });
    try {
      return await ontology.savePackageDraft(projectIdOf(request), body as OntologyPackage);
    } catch (error) {
      return rejectOntologyError(reply, error);
    }
  });

  app.delete("/api/projects/:projectId/ontology-packages/:packageId", async (request, reply) => {
    if (!await ensureProject(request, reply)) return;
    if (!requireWriter(request, reply)) return;
    try {
      return (await ontology.deletePackage(projectIdOf(request), packageIdOf(request)))
        ? reply.code(204).send()
        : reply.code(404).send({ message: "本体包不存在" });
    } catch (error) {
      return rejectOntologyError(reply, error);
    }
  });

  app.post("/api/projects/:projectId/ontology-packages/:packageId/submit-review", async (request, reply) => {
    if (!await ensureProject(request, reply)) return;
    if (!requireWriter(request, reply)) return;
    try {
      return await ontology.transitionStatus(projectIdOf(request), packageIdOf(request), "review", actorOf(request));
    } catch (error) {
      return rejectOntologyError(reply, error);
    }
  });

  app.post("/api/projects/:projectId/ontology-packages/:packageId/reject", async (request, reply) => {
    if (!await ensureProject(request, reply)) return;
    if (!requireWriter(request, reply)) return;
    try {
      return await ontology.transitionStatus(projectIdOf(request), packageIdOf(request), "draft", actorOf(request), (request.body as { reason?: string } | undefined)?.reason);
    } catch (error) {
      return rejectOntologyError(reply, error);
    }
  });

  app.post("/api/projects/:projectId/ontology-packages/:packageId/publish", async (request, reply) => {
    if (!await ensureProject(request, reply)) return;
    if (!requireWriter(request, reply)) return;
    try {
      const ctx = buildOntologyPublishContext(store, projectIdOf(request), listCapabilities);
      return await ontology.publishPackage(projectIdOf(request), packageIdOf(request), actorOf(request), ctx);
    } catch (error) {
      return rejectOntologyError(reply, error);
    }
  });

  app.post("/api/projects/:projectId/ontology-packages/:packageId/retire", async (request, reply) => {
    if (!await ensureProject(request, reply)) return;
    if (!requireWriter(request, reply) || !requireAdmin(request, reply)) return;
    try {
      return await ontology.transitionStatus(projectIdOf(request), packageIdOf(request), "retired", actorOf(request));
    } catch (error) {
      return rejectOntologyError(reply, error);
    }
  });

  app.get("/api/projects/:projectId/ontology-packages/:packageId/versions", async (request, reply) => {
    if (!await ensureProject(request, reply)) return;
    try {
      const packageId = packageIdOf(request);
      const [snapshots, history] = await Promise.all([
        ontology.getSnapshots(projectIdOf(request), packageId),
        ontology.getHistory(projectIdOf(request), packageId),
      ]);
      return {
        versions: snapshots.map(({ snapshotId, version, fingerprint, publishedAt, publishedBy }) => ({ snapshotId, version, fingerprint, publishedAt, publishedBy })),
        history,
      };
    } catch (error) {
      return rejectOntologyError(reply, error);
    }
  });

  app.post("/api/projects/:projectId/ontology-packages/:packageId/rollback", async (request, reply) => {
    if (!await ensureProject(request, reply)) return;
    if (!requireWriter(request, reply)) return;
    const snapshotId = (request.body as { snapshotId?: string } | undefined)?.snapshotId;
    if (!snapshotId) return reply.code(400).send({ message: "缺少 snapshotId" });
    try {
      return await ontology.rollbackToSnapshot(projectIdOf(request), packageIdOf(request), snapshotId, actorOf(request));
    } catch (error) {
      return rejectOntologyError(reply, error);
    }
  });

  app.post("/api/projects/:projectId/ontology-packages/:packageId/clone-draft", async (request, reply) => {
    if (!await ensureProject(request, reply)) return;
    if (!requireWriter(request, reply)) return;
    try {
      return await ontology.cloneAsDraft(projectIdOf(request), packageIdOf(request), actorOf(request));
    } catch (error) {
      return rejectOntologyError(reply, error);
    }
  });
}
