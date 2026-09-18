import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { validateDashboardWebPackageStructure, type DashboardWebPackage } from "@bim-studio/contracts";

/** 合同本体在 @bim-studio/contracts；此处保持既有 import 路径稳定，并补上 deep-engine 摘要断言。 */
export {
  assertDashboardWebSource,
  dashboardFrozenFontStyle,
  dashboardWebPath,
  DASHBOARD_WEB_FILE_LIMIT,
  DASHBOARD_WEB_TOTAL_LIMIT,
  validateDashboardWebPackageStructure,
  type DashboardWebPackage,
  type DashboardWebResource,
} from "@bim-studio/contracts";

export function assertDashboardWebPackage(value: unknown): asserts value is DashboardWebPackage {
  validateDashboardWebPackageStructure(value);
  const item = value as DashboardWebPackage;
  if (runtimeContentSha256(item.publication) !== item.publicationSha256) throw new Error("静态包发布摘要不匹配");
  const {contentSha256,...body} = item;
  if (runtimeContentSha256(body) !== contentSha256) throw new Error("静态包清单摘要不匹配");
}
