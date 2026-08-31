/**
 * 区分“验收机没有 WebGPU”与“产品在可用 WebGPU 上初始化失败”。
 * 后者始终是回归，不能因 WebGPU 尚未成为默认后端而静默跳过。
 */
export function classifyRendererInitialization(testCase, environment, error) {
  if (!error) return { environmentBlocked: false, failures: [] };
  const environmentBlocked = testCase.backend === "webgpu"
    && (!environment.secureContext || !environment.webGpuApi || !environment.webGpuAdapter);
  if (!environmentBlocked) {
    return { environmentBlocked: false, failures: [`渲染器初始化失败：${error}`] };
  }
  return {
    environmentBlocked: true,
    failures: testCase.required
      ? ["严格 WebGPU 门禁缺少安全上下文、WebGPU API 或可用适配器"]
      : []
  };
}
