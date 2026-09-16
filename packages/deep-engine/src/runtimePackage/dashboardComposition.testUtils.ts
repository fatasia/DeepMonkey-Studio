import { readFileSync } from "node:fs";
import { dashboardCompositionFixture } from "./dashboardCompositionFixture.testUtils.js";
import { buildDashboardCompositionRuntimePackage } from "./dashboardComposition.js";
import { runtimeContentSha256, runtimePackageSha256 } from "./hash.js";
import type { DashboardRuntimeV1 } from "./dashboardCompositionTypes.js";
import type { DeepRuntimePackageV5 } from "./types.js";

export type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
export const json = (name: string) => JSON.parse(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8"));
export function input() {
  const content = json("dashboard-runtime-v1.json");
  return dashboardCompositionFixture(json("chart-ir-v1.json"), json("chart-sim-v1.json"), content.payloads[content.entrypoints.deep2d]);
}
export const build = () => buildDashboardCompositionRuntimePackage(input());
export const draft = () => structuredClone(build()) as Mutable<DeepRuntimePackageV5>;
export const root = (value: Mutable<DeepRuntimePackageV5>) => value.payloads[value.entrypoints.dashboard] as unknown as Mutable<DashboardRuntimeV1>;
export function rehash(value: Mutable<DeepRuntimePackageV5>): void {
  for (const resource of value.resources) resource.contentHash.value = runtimeContentSha256(value.payloads[resource.id]);
  value.packageHash.value = runtimePackageSha256(value);
}
