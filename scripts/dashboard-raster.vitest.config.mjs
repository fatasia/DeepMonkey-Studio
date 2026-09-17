import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path => fileURLToPath(new URL(`../${path}`, import.meta.url));
export default {
  root,
  resolve: { alias: [
    { find: "@bim-studio/data-runtime", replacement: source("packages/data-runtime/src/index.ts") },
    { find: "@bim-studio/deep-engine/runtime-package", replacement: source("packages/deep-engine/src/runtimePackage/index.ts") },
    { find: "@bim-studio/deep-engine/shader-package", replacement: source("packages/deep-engine/src/shaderPackage/index.ts") },
    { find: "@bim-studio/deep-engine", replacement: source("packages/deep-engine/src/index.ts") },
    { find: "@bim-studio/contracts", replacement: source("packages/contracts/src/index.ts") },
  ] },
  test: { environment: "node", include: [
    "apps/web/src/delivery/compileDashboardRasterContent.test.ts",
    "apps/web/src/delivery/compileDashboardLayout.test.ts",
    "apps/web/src/delivery/dashboardTextContent.test.ts",
    "apps/web/src/delivery/dashboardColor.test.ts",
    "apps/web/src/delivery/dashboardData*.test.ts",
    "apps/web/src/delivery/dashboardTable*.test.ts",
    "apps/web/src/delivery/captureDashboardDataLayout.test.ts",
    "apps/web/src/delivery/lowerDashboardChart.test.ts",
    "apps/web/src/components/dashboardAnalytics.test.ts",
    "apps/web/src/components/dashboardMetricDisplay.test.ts",
    "apps/web/src/components/dashboard*Metrics.test.ts",
    "apps/web/src/delivery/compileDashboardContent.test.ts",
    "packages/contracts/src/dashboardDocument*.test.ts",
    "scripts/lib/dashboardRasterEndToEnd.vitest.mjs",
    "scripts/lib/dashboardDataEndToEnd.vitest.mjs",
    "scripts/lib/dashboardChartLayout.vitest.mjs",
  ] },
};
