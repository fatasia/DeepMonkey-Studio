import type { SceneSnapshot } from "@bim-studio/contracts";
import { translate, type AppLocale } from "../i18n";

interface PublicationMessageInput {
  locale: AppLocale;
  sceneName: string;
  mode: NonNullable<SceneSnapshot["publicationMode"]>;
  performanceProfile: NonNullable<SceneSnapshot["publicationPerformance"]>;
  cloudViewerReady?: boolean;
}

/** 发布事务只传递事实，这里统一生成面向用户的完成反馈。 */
export function publicationSuccessMessage(input: PublicationMessageInput): string {
  if (input.mode === "cloud") {
    return input.cloudViewerReady
      ? translate(input.locale, `场景“${input.sceneName}”已发布 · 云渲染已启动，可复制独立链接`, `Scene “${input.sceneName}” published · cloud rendering started; its separate link is ready`)
      : translate(input.locale, `场景“${input.sceneName}”已发布 · 云渲染会话正在建立`, `Scene “${input.sceneName}” published · cloud session is starting`);
  }
  const renderer = input.mode === "webgpu-preferred" ? "WebGPU 优先" : "WebGL";
  const optimization = input.performanceProfile === "fast" ? " · 自动优化" : "";
  return `场景“${input.sceneName}”已发布 · ${renderer}${optimization}`;
}
