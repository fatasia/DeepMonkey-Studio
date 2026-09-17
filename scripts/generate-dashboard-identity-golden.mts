// 从 dashboard 组合 v5 夹具导出跨语言身份 golden：TS 与 Native 两侧解析器
// 必须在同一包上看到完全一致的结构视图（不涉像素与坐标数值）。
import { readFileSync, writeFileSync } from "node:fs";
import { parseDeepRuntimePackage } from "../packages/deep-engine/src/runtimePackage/index.ts";
import { dashboardIdentityGoldenView } from "../packages/deep-engine/src/runtimePackage/identityGolden.ts";

const fixtureUrl = new URL("../packages/deep-engine/fixtures/dashboard-composition-v1.json", import.meta.url);
const goldenUrl = new URL("../packages/deep-engine/fixtures/dashboard-composition-identity-golden.json", import.meta.url);
const parsed = parseDeepRuntimePackage(readFileSync(fixtureUrl));
if (!parsed.valid) throw new Error(`Fixture failed validation: ${parsed.issues[0]?.message ?? "unknown"}`);
const golden = dashboardIdentityGoldenView(parsed.value);
writeFileSync(goldenUrl, JSON.stringify(golden, null, 2) + "\n");
console.log(`identity golden written: ${Object.keys(golden.payloads).length} payloads, ${golden.resources.length} resources`);
