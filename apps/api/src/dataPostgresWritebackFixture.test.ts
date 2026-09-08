import { afterEach, describe, expect, it, vi } from "vitest";
import { createIsolatedPostgres, postgresFixtureTools } from "../scripts/isolatedPostgresFixture.mjs";
afterEach(() => vi.unstubAllEnvs());
describe("PostgreSQL 工具缺失不影响普通单测，也不回退正常库", () => {
  it("显式无效工具目录不偷偷回退到系统目录", () => {
    vi.stubEnv("BIM_WRITEBACK_PG_BIN", "bim-test-deliberately-missing-postgres-tools");
    expect(postgresFixtureTools()).toBeUndefined();
  });
  it("要求真实PG的浏览器夹具明确失败并给配置指引", async () => {
    vi.stubEnv("BIM_WRITEBACK_PG_BIN", "bim-test-deliberately-missing-postgres-tools");
    await expect(createIsolatedPostgres()).rejects.toThrow("BIM_WRITEBACK_PG_BIN");
  });
});
