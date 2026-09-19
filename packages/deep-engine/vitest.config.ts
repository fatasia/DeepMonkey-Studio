import { defineConfig } from "vitest/config";

// WIP 排除:并行会话在途文件(benchmarkTrajectoryReplay 等)未达可运行状态,
// 完成后由归属车道从此清单移除。来源见 docs/specs/de26-master-execution-roadmap-2026-09-19.md。
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "lab/**/*.test.ts"],
    exclude: ["**/node_modules/**", "lab/benchmarkTrajectoryReplay.test.ts"],
  },
});
