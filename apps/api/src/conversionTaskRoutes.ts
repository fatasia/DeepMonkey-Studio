import type { SubmitConversionTaskRequest } from "@bim-studio/contracts";
import type { FastifyInstance } from "fastify";
import { ConversionTaskError, type ConversionTaskService } from "./conversionTasks.js";

interface RouteDependencies {
  service: ConversionTaskService;
  projectExists(projectId: string): boolean;
}

type SubmitBody = Omit<SubmitConversionTaskRequest, "projectId">;

export async function registerConversionTaskRoutes(app: FastifyInstance, dependencies: RouteDependencies): Promise<void> {
  const { service, projectExists } = dependencies;

  app.get("/api/converters", async () => service.listPlugins());
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/conversion-tasks", async (request, reply) => {
    if (!projectExists(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    return service.list(request.params.projectId);
  });
  app.post<{ Params: { projectId: string }; Body: SubmitBody }>("/api/projects/:projectId/conversion-tasks", async (request, reply) => {
    if (!projectExists(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    try {
      const task = service.submit({ ...request.body, projectId: request.params.projectId });
      return reply.code(202).send(task);
    } catch (error) {
      return sendTaskError(reply, error);
    }
  });
  app.get<{ Params: { projectId: string; taskId: string } }>("/api/projects/:projectId/conversion-tasks/:taskId", async (request, reply) => {
    const task = service.get(request.params.projectId, request.params.taskId);
    return task ?? reply.code(404).send({ message: "转换任务不存在" });
  });
  app.post<{ Params: { projectId: string; taskId: string } }>("/api/projects/:projectId/conversion-tasks/:taskId/cancel", async (request, reply) => {
    try {
      return service.cancel(request.params.projectId, request.params.taskId);
    } catch (error) {
      return sendTaskError(reply, error);
    }
  });
}

function sendTaskError(reply: { code(statusCode: number): { send(payload: { message: string }): unknown } }, error: unknown): unknown {
  if (!(error instanceof ConversionTaskError)) throw error;
  const statusCode = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400;
  return reply.code(statusCode).send({ message: error.message });
}
