type ApiRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

export interface Modeling3dSubmitResult {
  taskId: string;
  status: "pending" | "running" | "success" | "failed";
  provider: "tripo3d" | "tencentHunyuan";
  error?: string;
}

export interface Modeling3dStatus {
  taskId: string;
  status: "pending" | "running" | "success" | "failed";
  progress?: number;
  modelUrl?: string;
  error?: string;
  provider: "tripo3d" | "tencentHunyuan";
}

export function createModeling3dApi(request: ApiRequest) {
  return {
    submit: (prompt: string, provider: "tripo3d" | "tencentHunyuan") =>
      request<Modeling3dSubmitResult>("/api/ai/modeling3d/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, provider }),
      }),
    poll: (taskId: string) =>
      request<Modeling3dStatus>("/api/ai/modeling3d/" + taskId),
  };
}