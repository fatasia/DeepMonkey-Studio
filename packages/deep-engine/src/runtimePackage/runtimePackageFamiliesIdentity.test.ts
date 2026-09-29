import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseDeepRuntimePackage } from "./index.js";
import { compareText } from "../textOrder.js";

// J3 Gate A/B 扩族:runtime-package 六个 native fixture(environment/IBL/shader/camera/lod
// 全家族)的身份视图对拍。规则与 packages/deep-engine-native/tests/dashboard_identity_golden.rs
// 的扩展分支逐条镜像(同规则同输入),入库 golden 是唯一仲裁:
// packages/deep-engine-native/tests/fixtures/runtime-package-families-identity-golden.json。
// 视图不含像素与坐标数值(相机只带 near/far/fov 标量与 presence,不含 position/target)。

const FIXTURES_ROOT = new URL("../../../deep-engine-native/tests/fixtures/", import.meta.url);
const GOLDEN_NAME = "runtime-package-families-identity-golden.json";

const FAMILY_FIXTURES = [
  "runtime-package-v1.json",
  "runtime-package-lod-v1.json",
  "runtime-package-author-lod-v1.json",
  "runtime-package-prefiltered-ibl-v1.json",
  "runtime-package-camera-v3.json",
  "runtime-package-shader-v2.json",
] as const;

const count = (items: unknown): number => (Array.isArray(items) ? items.length : 0);
const sortedIds = (items: { id: string }[]): string[] => items.map((item) => item.id).sort(compareText);

type RawPayload = Record<string, unknown>;

export function payloadIdentityView(
  entrypoints: Record<string, unknown>,
  id: string,
  payload: RawPayload,
): Record<string, unknown> {
  const entry = (key: string): string | null =>
    typeof entrypoints[key] === "string" ? (entrypoints[key] as string) : null;
  const schema = typeof payload.schema === "string" ? payload.schema : null;
  const kind =
    id === entry("dashboard") ? "dashboard-runtime"
    : id === entry("renderPacket") ? "render-packet"
    : id === entry("environment") ? "environment"
    : "chart" in payload ? "chart-runtime"
    : "fixture" in payload ? "chart-sim-runtime"
    : "atlases" in payload ? "deep2d-runtime"
    : schema === "deep-engine.scene-camera" ? "scene-camera"
    : schema === "deep-shader-package" ? "shader-package"
    : schema === "deep-engine.ibl-prefiltered" ? "environment-ibl"
    : schema === "deep-engine.ibl-reference" ? "environment"
    : null;
  if (kind === null) throw new Error(`Payload ${id} has no recognised identity shape`);
  // TS base 对象里值为 undefined 的键会被 JSON.stringify 省略;只插实际存在的身份键。
  const view: Record<string, unknown> = { kind };
  for (const key of ["revision", "schema", "schemaVersion"]) {
    if (key in payload && payload[key] !== undefined) view[key] = payload[key];
  }
  if (kind === "dashboard-runtime") {
    view.documentId = payload.documentId;
    view.entryPageId = payload.entryPageId;
    view.pages = count(payload.pages);
  } else if (kind === "render-packet") {
    view.version = payload.version;
    for (const key of ["geometries", "instances", "materials", "textures"]) view[key] = count(payload[key]);
    const instances = Array.isArray(payload.instances) ? (payload.instances as RawPayload[]) : [];
    if (instances.some((instance) => "lod" in instance)) {
      // J3 扩族:lod 家族只记实例/层级计数,不含几何误差与投影数值。
      view.lodInstances = instances.filter((instance) => "lod" in instance).length;
      view.lodLevelsTotal = instances.reduce((sum, instance) => {
        const levels = (instance.lod as { levels?: unknown[] } | undefined)?.levels;
        return sum + (Array.isArray(levels) ? levels.length : 0);
      }, 0);
    }
  } else if (kind === "deep2d-runtime") {
    view.atlases = count(payload.atlases);
    view.quads = count(payload.quads);
    view.atlasIds = sortedIds(payload.atlases as { id: string }[]);
    view.quadIds = sortedIds(payload.quads as { id: string }[]);
  } else if (kind === "chart-runtime") {
    view.chartId = (payload.chart as { chartId?: string } | null | undefined)?.chartId ?? null;
  } else if (kind === "chart-sim-runtime") {
    view.fixtureId = (payload.fixture as { id?: string }).id ?? null;
  } else if (schema === "deep-engine.ibl-prefiltered") {
    // IBL 家族:预滤波档位与 mip 计数;base64 体素不进视图。
    view.payloadKind = payload.kind;
    view.format = payload.format;
    view.encoding = payload.encoding;
    view.faceOrder = payload.faceOrder;
    view.diffuseMips = count((payload.diffuse as { mips?: unknown[] } | undefined)?.mips);
    view.specularMips = count((payload.specular as { mips?: unknown[] } | undefined)?.mips);
    view.hasBrdfLut = "brdfLut" in payload;
    view.hasSource = "source" in payload;
  } else if (kind === "scene-camera") {
    // 相机家族:只带标量调参(near/far/fov)与 target presence;position/target 坐标不进视图。
    view.near = payload.near;
    view.far = payload.far;
    view.verticalFovDegrees = payload.verticalFovDegrees;
    view.hasTarget = "target" in payload;
  } else if (kind === "shader-package") {
    // 着色器家族:身份字段与 module/pass 计数与 id 集;WGSL source 字节不进视图。
    view.packageId = payload.packageId;
    view.packageVersion = payload.packageVersion;
    view.compilerVersion = payload.compilerVersion;
    view.targetProfile = payload.targetProfile;
    const abi = payload.shaderAbi as { id?: string; contentHash?: { value?: string } } | undefined;
    view.shaderAbiId = abi?.id ?? null;
    view.shaderAbiContentHash = abi?.contentHash?.value ?? null;
    const modules = Array.isArray(payload.modules) ? (payload.modules as { id: string }[]) : [];
    view.moduleCount = modules.length;
    view.moduleIds = sortedIds(modules);
    const passes = Array.isArray(payload.passes) ? (payload.passes as { id: string }[]) : [];
    view.passCount = passes.length;
    view.passIds = sortedIds(passes);
    view.dependencyCount = Array.isArray(payload.dependencies) ? payload.dependencies.length : 0;
  }
  return view;
}

interface IdentityViewParts {
  packageId: string;
  packageVersion: string;
  schemaVersion: number;
  packageHash: unknown;
  entrypoints: Record<string, unknown>;
  payloads: Record<string, RawPayload>;
  resources: { id: string; kind: string; revision: number }[];
}

function identityViewFromParts(pkg: IdentityViewParts): Record<string, unknown> {
  const payloads: Record<string, Record<string, unknown>> = {};
  for (const [id, payload] of Object.entries(pkg.payloads)) {
    payloads[id] = payloadIdentityView(pkg.entrypoints, id, payload);
  }
  return {
    package: {
      packageId: pkg.packageId,
      packageVersion: pkg.packageVersion,
      schemaVersion: pkg.schemaVersion,
      packageHash: pkg.packageHash,
    },
    entrypoints: pkg.entrypoints,
    payloads: Object.fromEntries(Object.entries(payloads).sort(([a], [b]) => compareText(a, b))),
    resources: [...pkg.resources]
      .map(({ id, kind, revision }) => ({ id, kind, revision }))
      .sort((a, b) => compareText(a.id, b.id)),
  };
}

function familiesIdentityView(raw: RawPayload): Record<string, unknown> {
  const parsed = parseDeepRuntimePackage(JSON.stringify(raw));
  if (!parsed.valid) throw new Error(parsed.issues[0]?.message ?? "fixture invalid");
  return identityViewFromParts(parsed.value as unknown as IdentityViewParts);
}

/** 篡改样本绕过生产解析器(其会先在 packageHash 处拒收)直接建视图,验证视图层漂移可见。 */
function rawIdentityView(raw: RawPayload): Record<string, unknown> {
  return identityViewFromParts(raw as unknown as IdentityViewParts);
}

const readFixture = (name: string): RawPayload =>
  JSON.parse(readFileSync(new URL(name, FIXTURES_ROOT), "utf8")) as RawPayload;
const golden = JSON.parse(readFileSync(new URL(GOLDEN_NAME, FIXTURES_ROOT), "utf8")) as {
  schema: string;
  schemaVersion: number;
  fixtures: Record<string, Record<string, unknown>>;
};

describe("runtime package families identity golden (J3 Gate A/B 扩族)", () => {
  it("covers every native family fixture with the committed golden sections", () => {
    expect(golden.schema).toBe("deep-engine.runtime-package-families-identity-golden");
    expect(Object.keys(golden.fixtures).sort()).toEqual([...FAMILY_FIXTURES].sort());
    for (const name of FAMILY_FIXTURES) {
      const view = familiesIdentityView(readFixture(name));
      expect(view).toEqual(golden.fixtures[name]);
    }
  });

  it("re-exports stay byte-stable across repeated invocations for every family", () => {
    for (const name of FAMILY_FIXTURES) {
      const first = JSON.stringify(familiesIdentityView(readFixture(name)));
      const second = JSON.stringify(familiesIdentityView(readFixture(name)));
      expect(first).toBe(second);
      expect(first.length).toBeGreaterThan(0);
    }
  });

  it("rejects family identity drift before any consumer loads the package", () => {
    const tamperCases = [
      { name: "runtime-package-camera-v3.json", id: "scene.camera", mutate: (payload: RawPayload) => { payload.far = 99999; } },
      { name: "runtime-package-shader-v2.json", id: "deep.runtime.opaque", mutate: (payload: RawPayload) => { payload.compilerVersion = "0.0.1"; } },
      {
        name: "runtime-package-prefiltered-ibl-v1.json",
        id: "environment.prefiltered.golden",
        mutate: (payload: RawPayload) => { delete payload.brdfLut; },
      },
      {
        name: "runtime-package-lod-v1.json",
        id: "scene.lod",
        mutate: (payload: RawPayload) => { delete ((payload.instances as RawPayload[])[0] as RawPayload).lod; },
      },
    ] as const;
    for (const testCase of tamperCases) {
      const tampered = structuredClone(readFixture(testCase.name));
      testCase.mutate((tampered.payloads as RawPayload)[testCase.id]);
      // 层 1:生产合同在 packageHash 处 fail-closed 拒收任何字节篡改。
      const parsed = parseDeepRuntimePackage(JSON.stringify(tampered));
      expect(parsed.valid, `${testCase.name} tampered bytes must be rejected by the product contract`).toBe(false);
      // 层 2:身份视图层同样能看见漂移(不依赖 hash)。
      expect(rawIdentityView(tampered)).not.toEqual(golden.fixtures[testCase.name]);
    }
  });
});
