import { defineConfig } from "vitest/config";

// WIP 排除:并行会话在途文件(benchmarkTrajectoryReplay 等)未达可运行状态,
// 临时验证夹具应在对应能力稳定后移入常规测试套件。
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "lab/**/*.test.ts"],
    exclude: ["**/node_modules/**", "lab/benchmarkTrajectoryReplay.test.ts"],
  },
});
