import type { AppViewBindings } from "./appViewBindings";
import { AppBehaviorOverlay } from "./AppBehaviorOverlay";
import { AppDialogOverlays } from "./AppDialogOverlays";
import { AppPlatformOverlays } from "./AppPlatformOverlays";

/**
 * 应用级浮层入口只负责组合，不再订阅数百个业务字段。
 * 各浮层按脚本、业务对话框和平台工具拆分，便于独立维护与回归测试。
 */
export function AppOverlays({ bindings }: { bindings: AppViewBindings }) {
  if (!bindings.state.currentUser) return null;

  return (
    <>
      <AppBehaviorOverlay bindings={bindings} />
      <AppDialogOverlays bindings={bindings} />
      <AppPlatformOverlays bindings={bindings} />
    </>
  );
}
