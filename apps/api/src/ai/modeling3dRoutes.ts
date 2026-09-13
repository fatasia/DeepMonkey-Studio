import { createHash, createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { MetadataStore } from "../store.js";
import { resolveAiSettings } from "./aiRuntimeSettings.js";

const jobs = new Map<string, Modeling3dJob>();

interface Modeling3dJob {
  id: string;
  provider: "tripo3d" | "tencentHunyuan";
  status: "pending" | "running" | "success" | "failed";
  progress: number | undefined;
  modelUrl: string | undefined;
  error: string | undefined;
  remoteTaskId?: string;
  prompt: string;
  createdAt: string;
}

export async function registerModeling3dRoutes(
  app: FastifyInstance,
  dependencies: { store: Pick<MetadataStore, "getAiSettings"> },
) {
  app.post<{ Body: { prompt?: string; provider?: string } }>("/api/ai/modeling3d/generate", async (request, reply) => {
    const prompt = request.body?.prompt?.trim();
    if (!prompt || prompt.length < 3) return reply.code(400).send({ message: "请输入至少 3 个字符的模型描述" });
    const providerId = request.body?.provider === "tencentHunyuan" ? "tencentHunyuan" : "tripo3d";
    const settings = resolveAiSettings(dependencies.store);
    const modeling3d = settings.modeling3d;
    if (!modeling3d) return reply.code(503).send({ message: "3D 生成尚未配置" });
    const provider = modeling3d[providerId];
    if (!provider?.apiKey || (providerId === "tencentHunyuan" && !provider.secretId)) return reply.code(400).send({ message: providerId === "tripo3d" ? "请在设置页配置 Tripo3D 的 API Key" : "请在设置页配置混元 3D 的 Secret ID 与 Secret Key" });
    const job: Modeling3dJob = { id: randomUUID(), provider: providerId, status: "pending", prompt, createdAt: new Date().toISOString(), progress: undefined, modelUrl: undefined, error: undefined };
    jobs.set(job.id, job);
    try {
      job.remoteTaskId = providerId === "tripo3d"
        ? await createTripoTask(provider.baseUrl, provider.apiKey, prompt)
        : await createHunyuanTask(provider.baseUrl, provider.secretId!, provider.apiKey, provider.region ?? "ap-guangzhou", provider.model, prompt);
      job.status = "running";
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : "提交任务失败";
    }
    reply.header("cache-control", "no-store");
    return { taskId: job.id, status: job.status, provider: job.provider, error: job.error };
  });

  app.get<{ Params: { taskId: string } }>("/api/ai/modeling3d/:taskId", async (request, reply) => {
    const job = jobs.get(request.params.taskId);
    if (!job) return reply.code(404).send({ message: "任务不存在或已过期" });
    if (job.status === "running" && job.remoteTaskId) {
      try {
        const settings = resolveAiSettings(dependencies.store);
        const provider = settings.modeling3d?.[job.provider];
        if (provider?.apiKey && (job.provider === "tripo3d" || provider.secretId)) {
          const result = job.provider === "tripo3d"
            ? await pollTripoTask(provider.baseUrl, provider.apiKey, job.remoteTaskId)
            : await pollHunyuanTask(provider.baseUrl, provider.secretId!, provider.apiKey, provider.region ?? "ap-guangzhou", job.remoteTaskId);
          job.status = result.status ?? job.status;
          job.progress = result.progress;
          job.modelUrl = result.modelUrl;
          if (result.error) job.error = result.error;
        }
      } catch { /* keep state */ }
    }
    reply.header("cache-control", "no-store");
    return { taskId: job.id, status: job.status, progress: job.progress, modelUrl: job.modelUrl, error: job.error, provider: job.provider };
  });
}

async function createTripoTask(baseUrl: string, apiKey: string, prompt: string): Promise<string> {
  const res = await fetch(baseUrl + "/v2/openapi/task", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify({ type: "text_to_model", prompt }),
  });
  const data = await res.json() as { data?: { task_id?: string }; message?: string };
  if (!res.ok || !data.data?.task_id) throw new Error(data.message || "Tripo3D submit failed (HTTP " + res.status + ")");
  return data.data.task_id;
}

async function pollTripoTask(baseUrl: string, apiKey: string, taskId: string): Promise<Partial<Modeling3dJob>> {
  const res = await fetch(baseUrl + "/v2/openapi/task/" + taskId, { headers: { Authorization: "Bearer " + apiKey } });
  const data = await res.json() as { data?: { status?: string; progress?: number; output?: { pbr_model?: string; model?: string } }; message?: string };
  if (!res.ok) return { status: "failed", error: data.message || "Tripo3D poll failed (HTTP " + res.status + ")" };
  const d = data.data;
  const status = d?.status === "success" ? "success" : d?.status === "failed" ? "failed" : "running";
  return {
    status,
    progress: d?.progress,
    ...(status === "success" ? { modelUrl: d?.output?.pbr_model || d?.output?.model } : {}),
    ...(status === "failed" ? { error: "Tripo3D generation failed" } : {}),
  };
}

async function createHunyuanTask(baseUrl: string, secretId: string, secretKey: string, region: string, model: string, prompt: string): Promise<string> {
  const response = await callTencentCloudApi<{ JobId?: string }>(baseUrl, secretId, secretKey, region, "SubmitHunyuanTo3DProJob", {
    Prompt: prompt.slice(0, 1024),
    Model: model === "3.0" ? "3.0" : "3.1",
  });
  if (!response.JobId) throw new Error("混元 3D 未返回任务 ID");
  return response.JobId;
}

async function pollHunyuanTask(baseUrl: string, secretId: string, secretKey: string, region: string, taskId: string): Promise<Partial<Modeling3dJob>> {
  const response = await callTencentCloudApi<{ Status?: string; ErrorCode?: string; ErrorMessage?: string; ResultFile3Ds?: Array<{ Type?: string; Url?: string }> }>(baseUrl, secretId, secretKey, region, "QueryHunyuanTo3DProJob", { JobId: taskId });
  const status = response.Status === "DONE" ? "success" : response.Status === "FAIL" ? "failed" : "running";
  const modelUrl = response.ResultFile3Ds?.find((file) => file.Type?.toUpperCase() === "GLB")?.Url ?? response.ResultFile3Ds?.[0]?.Url;
  return {
    status,
    ...(status === "success" && modelUrl ? { modelUrl } : {}),
    ...(status === "failed" ? { error: response.ErrorMessage || response.ErrorCode || "混元 3D 生成失败" } : {}),
  };
}

async function callTencentCloudApi<T extends object>(baseUrl: string, secretId: string, secretKey: string, region: string, action: string, body: object): Promise<T> {
  const endpoint = new URL(baseUrl);
  const host = endpoint.host;
  const payload = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const service = "ai3d";
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(payload)}`;
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256(canonicalRequest)}`;
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = createHmac("sha256", secretSigning).update(stringToSign).digest("hex");
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Host: host,
      Authorization: authorization,
      "X-TC-Action": action,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Version": "2025-05-13",
      "X-TC-Region": region,
    },
    body: payload,
  });
  const data = await res.json() as { Response?: T & { Error?: { Code?: string; Message?: string } } };
  const response = data.Response;
  if (!res.ok || !response || response.Error) throw new Error(response?.Error?.Message || response?.Error?.Code || `混元 3D 请求失败 (HTTP ${res.status})`);
  return response;
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function hmac(key: string | Buffer, value: string): Buffer { return createHmac("sha256", key).update(value).digest(); }
