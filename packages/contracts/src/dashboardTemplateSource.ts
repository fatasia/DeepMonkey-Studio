import { expectObject, expectPositiveInteger, invalid, required, requiredLiteral } from "./applicationValidationPrimitives.js";

/** 来源用于追溯，不授权联网更新或覆盖用户编辑后的页面。 */
export interface DashboardTemplateSource {
  kind: "industry-pack";
  packId: string;
  revision: number;
  pageTemplateId: string;
  instanceId: string;
}

export function validateDashboardTemplateSource(value: unknown, path: string): void {
  const source = expectObject(value, path);
  requiredLiteral(source, "kind", ["industry-pack"], path);
  required(source, "revision", expectPositiveInteger, path);
  for (const key of ["packId", "pageTemplateId", "instanceId"] as const) {
    required(source, key, (id, idPath) => {
      if (typeof id !== "string" || !id.trim() || id.length > 160 || /[\u0000-\u001f]/.test(id)) invalid(idPath, "必须是非空且不超过 160 字符的来源标识");
    }, path);
  }
}
