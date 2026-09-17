import { describe, expect, it } from "vitest";
import fixtureBytes from "../../fixtures/dashboard-composition-v1.json";
import golden from "../../fixtures/dashboard-composition-identity-golden.json";
import { parseDeepRuntimePackage } from "./index.js";
import { DASHBOARD_IDENTITY_GOLDEN_SCHEMA, dashboardIdentityGoldenView } from "./identityGolden.js";

const encoder = new TextEncoder();
const parseFixture = () => parseDeepRuntimePackage(encoder.encode(JSON.stringify(fixtureBytes)));

describe("dashboard identity golden (P0-07)", () => {
  it("parses the composition fixture into exactly the committed golden view", () => {
    const parsed = parseFixture();
    if (!parsed.valid) throw new Error(parsed.issues[0]?.message ?? "fixture invalid");
    expect(parsed.value.schemaVersion).toBe(5);
    expect(dashboardIdentityGoldenView(parsed.value)).toEqual(golden);
  });

  it("rejects golden drift in identity fields before any consumer loads the package", () => {
    const parsed = parseFixture();
    if (!parsed.valid) throw new Error(parsed.issues[0]?.message ?? "fixture invalid");
    const view = dashboardIdentityGoldenView(parsed.value);
    expect(golden.schema).toBe(DASHBOARD_IDENTITY_GOLDEN_SCHEMA);
    // 结构身份逐组独立断言,失败信息直接指向漂移的组,而不是一次 toEqual 全量对比。
    expect(view.package).toEqual(golden.package);
    expect(view.entrypoints).toEqual(golden.entrypoints);
    expect(Object.keys(view.payloads)).toEqual(Object.keys(golden.payloads));
    for (const [id, payload] of Object.entries(golden.payloads)) expect(view.payloads[id]).toEqual(payload);
    expect(view.resources).toEqual(golden.resources);
  });

  it("re-exports stay byte-stable across repeated invocations", () => {
    const parsed = parseFixture();
    if (!parsed.valid) throw new Error(parsed.issues[0]?.message ?? "fixture invalid");
    expect(JSON.stringify(dashboardIdentityGoldenView(parsed.value)))
      .toBe(JSON.stringify(dashboardIdentityGoldenView(parsed.value)));
  });
});
