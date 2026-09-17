// P0-07 跨语言身份 golden:把 v5 组合包解析后的结构视图导出为稳定 JSON,
// TS 与 Native 各自实现导出,入库 golden 是唯一仲裁;视图不含像素与坐标数值。
import type { DeepRuntimePackageV5 } from "./types.js";

export const DASHBOARD_IDENTITY_GOLDEN_SCHEMA = "deep-engine.dashboard-identity-golden";
export const DASHBOARD_IDENTITY_GOLDEN_VERSION = 1;

interface PayloadView {
  readonly kind: string;
  readonly revision: unknown;
  readonly schema: unknown;
  readonly schemaVersion: unknown;
  readonly [key: string]: unknown;
}

export function dashboardIdentityGoldenView(pkg: DeepRuntimePackageV5): {
  readonly schema: string;
  readonly schemaVersion: number;
  readonly fixture: string;
  readonly package: { readonly packageId: string; readonly packageVersion: number; readonly schemaVersion: number; readonly packageHash: unknown };
  readonly entrypoints: DeepRuntimePackageV5["entrypoints"];
  readonly payloads: Readonly<Record<string, PayloadView>>;
  readonly resources: readonly { readonly id: string; readonly kind: string; readonly revision: number }[];
} {
  const payloads: Record<string, PayloadView> = {};
  for (const [id, raw] of Object.entries(pkg.payloads)) {
    const payload = raw as Record<string, unknown>;
    const kind = id === pkg.entrypoints.dashboard ? "dashboard-runtime"
      : id === pkg.entrypoints.renderPacket ? "render-packet"
      : id === pkg.entrypoints.environment ? "environment"
      : "chart" in payload ? "chart-runtime"
      : "fixture" in payload ? "chart-sim-runtime"
      : "atlases" in payload ? "deep2d-runtime"
      : "unknown";
    if (kind === "unknown") throw new Error(`Payload ${id} has no recognised identity shape`);
    const base = { kind, revision: payload.revision, schema: payload.schema, schemaVersion: payload.schemaVersion };
    payloads[id] = kind === "dashboard-runtime" ? { ...base, documentId: payload.documentId,
        entryPageId: payload.entryPageId, pages: (payload.pages as unknown[]).length }
      : kind === "render-packet" ? { ...base, version: payload.version, geometries: (payload.geometries as unknown[]).length,
        instances: (payload.instances as unknown[]).length, materials: (payload.materials as unknown[]).length,
        textures: (payload.textures as unknown[]).length }
      : kind === "deep2d-runtime" ? { ...base, atlases: (payload.atlases as unknown[]).length, quads: (payload.quads as unknown[]).length,
        atlasIds: (payload.atlases as { id: string }[]).map(atlas => atlas.id).sort(),
        quadIds: (payload.quads as { id: string }[]).map(quad => quad.id).sort() }
      : kind === "chart-runtime" ? { ...base, chartId: (payload.chart as { chartId?: string } | null | undefined)?.chartId ?? null }
      : kind === "chart-sim-runtime" ? { ...base, fixtureId: (payload.fixture as { id?: string }).id ?? null }
      : base;
  }
  return {
    schema: DASHBOARD_IDENTITY_GOLDEN_SCHEMA, schemaVersion: DASHBOARD_IDENTITY_GOLDEN_VERSION,
    fixture: "dashboard-composition-v1.json",
    package: { packageId: pkg.packageId, packageVersion: pkg.packageVersion, schemaVersion: pkg.schemaVersion, packageHash: pkg.packageHash },
    entrypoints: pkg.entrypoints,
    payloads: Object.fromEntries(Object.entries(payloads).sort(([a], [b]) => a.localeCompare(b))),
    resources: [...pkg.resources].map(({ id, kind, revision }) => ({ id, kind, revision })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}
