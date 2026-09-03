import type { ApplicationObjectRef } from "@bim-studio/contracts";

/**
 * 编辑态嵌入视口初始化时会产生空选事件，不能因此清掉二维图层选择。
 * 运行态则保留“点击三维空白取消对象选择”的常规语义。
 */
export function sceneViewportSelection(
  sceneId: string,
  modelId: string | undefined,
  runtimeMode: boolean,
): readonly ApplicationObjectRef[] | undefined {
  if (modelId) return [{ kind: "object", sceneId, modelId }];
  return runtimeMode ? [] : undefined;
}
