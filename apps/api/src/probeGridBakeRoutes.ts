import type { FastifyInstance, FastifyReply } from "fastify";
import type { MetadataStore } from "./store.js";
import { loadProbeGridBakeDocument, normalizeProbeGridBakeDocument, storeProbeGridBakeDocument } from "./probeGridBakeStore.js";

/** 单份烘焙文档字节上限：单层 64^3×96B ≈ 25MB，级联 4 层翻倍仍有余量。 */
export const PROBE_BAKE_MAX_BYTES = 64 * 1024 * 1024;

interface ProbeGridBakeRouteDependencies {
  store: MetadataStore;
  dataDir: string;
  /** 测试注入小上限用；生产缺省 64MB。 */
  maxBytes?: number;
}

/**
 * GI 探针烘焙结果持久化端点（F3 发布一致性切片）。
 *
 * == 语义 ==
 * - PUT /api/scenes/:sceneId/probe-bake：body = { sourceHash, bake, probeCount?, coveredCount?, bakedAt? }。
 *   内容寻址：sourceHash 是浏览器端计算的编译器严格源投影哈希，同 hash 覆盖写即幂等；
 *   服务端只透传存储，不重复实现投影逻辑。
 * - GET /api/scenes/:sceneId/probe-bake?sourceHash=...：命中返回同一文档；未命中 404（=无，
 *   调用方静默降级，不报错）。(sceneId, sourceHash) 内容不可变，故带 immutable 缓存语义。
 * - 鉴权与既有场景路由一致：登录由 system.ts 的全局 preHandler 强制（401），viewer 写操作
 *   被其 403 规则覆盖；本模块不重复实现。
 * - 超限 413：路由级 bodyLimit 在解析层拒绝（Fastify 原生 413），文档层 byteLength 校验兜底。
 * - 降级语义：存储失败只影响可用性，绝不影响正确性——发布链按当前场景语义哈希精确匹配，
 *   对不上/读不到即不带探针，包语义与历史一致。
 */
export async function registerProbeGridBakeRoutes(app: FastifyInstance, dependencies: ProbeGridBakeRouteDependencies): Promise<void> {
  const { store, dataDir } = dependencies;
  const maxBytes = dependencies.maxBytes ?? PROBE_BAKE_MAX_BYTES;

  app.put<{ Params: { sceneId: string } }>("/api/scenes/:sceneId/probe-bake",
    { bodyLimit: maxBytes }, async (request, reply) => {
      if (!store.getSceneById(request.params.sceneId)) return reply.code(404).send({ message: "场景不存在" });
      return persistBake(reply, { dataDir, sceneId: request.params.sceneId, body: request.body, maxBytes });
    });

  app.get<{ Params: { sceneId: string }; Querystring: { sourceHash?: string } }>(
    "/api/scenes/:sceneId/probe-bake", async (request, reply) => {
      if (!request.query.sourceHash) return reply.code(400).send({ message: "缺少 sourceHash 查询参数" });
      let document;
      try {
        document = await loadProbeGridBakeDocument({
          dataDir, sceneId: request.params.sceneId, sourceHash: request.query.sourceHash,
        });
      } catch (reason) {
        return failBake(reply, reason);
      }
      if (!document) return reply.code(404).send({ message: "该场景语义哈希下没有已持久化的探针烘焙" });
      return reply.header("cache-control", "private, max-age=31536000, immutable").send(document);
    });
}

async function persistBake(reply: FastifyReply, input: {
  dataDir: string; sceneId: string; body: unknown; maxBytes: number;
}): Promise<FastifyReply> {
  let document;
  try {
    document = normalizeProbeGridBakeDocument(input.body, input.maxBytes);
  } catch (reason) {
    return failBake(reply, reason);
  }
  const result = await storeProbeGridBakeDocument({ dataDir: input.dataDir, sceneId: input.sceneId, document, maxBytes: input.maxBytes });
  return reply.header("cache-control", "no-store").send({
    sourceHash: document.sourceHash, bytes: result.bytes, compressedBytes: result.compressedBytes,
  });
}

function failBake(reply: FastifyReply, reason: unknown): FastifyReply {
  const status = (reason as { statusCode?: number }).statusCode;
  const code = status === 413 ? 413 : status === 400 ? 400 : 500;
  const message = reason instanceof Error ? reason.message : "探针烘焙文档无效";
  return reply.code(code).send({ message });
}
