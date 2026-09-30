import test from "node:test";
import assert from "node:assert/strict";
import {
  GATE_PAIRS, buildEvidence, executeGate, formatReport, parseArgs, resolveGpuPolicy,
} from "./j5-dual-end-gate.mjs";

// J5 双端门脚本自测:全部走注入式 runner,不触 cargo/GPU/Chrome。
// 覆盖:计划形状与命令锚定、策略解析、全绿、任一端红、GPU 三策略、
// 命令级复用(去重)、执行器报错路径、报告与证据序列化。

function makeRunner({ statusByNeedle = {}, defaultStatus = 0 } = {}) {
  const calls = [];
  const runner = (leg) => {
    calls.push(leg.command);
    const hit = Object.entries(statusByNeedle).find(([needle]) => leg.command.includes(needle));
    const status = hit ? hit[1] : defaultStatus;
    return {
      status,
      durationMs: 12,
      tail: status === 0 ? "all green" : `FAIL: ${leg.id} red tail`,
    };
  };
  return { runner, calls };
}

const passRunner = () => makeRunner();

test("十一对判据计划形状与命令锚定(漂移即红)", () => {
  assert.equal(GATE_PAIRS.length, 11);
  const [furnace, identity, cloth, hash, frameAbi] = GATE_PAIRS;
  assert.equal(frameAbi.id, "frame-abi-schema");
  assert.equal(frameAbi.legs[0].command.includes("frameLayout.test.ts"), true);
  assert.equal(frameAbi.legs[1].command.includes("--lib frame_layout"), true);
  for (const pair of GATE_PAIRS) {
    assert.equal(pair.legs.length, 2, `${pair.id} 必须双腿`);
    assert.deepEqual(pair.legs.map((leg) => leg.side).sort(), ["native", "ts"]);
  }
  assert.equal(furnace.id, "white-furnace");
  assert.equal(furnace.legs[0].command, "pnpm --filter @bim-studio/deep-engine test:white-furnace-gpu");
  assert.equal(furnace.legs[0].requiresGpu, true, "TS 白炉是真机 GPU 腿");
  assert.equal(furnace.legs[1].command.endsWith("--lib white_furnace"), true);
  assert.equal(furnace.legs[1].requiresGpu, false, "Native 白炉含 CPU 判据,必须无条件跑");
  assert.ok(identity.legs[0].command.includes("identityGolden.test.ts"));
  assert.ok(identity.legs[0].command.includes("runtimePackageFamiliesIdentity.test.ts"));
  assert.equal(identity.legs[1].command.endsWith("--test dashboard_identity_golden"), true);
  assert.ok(cloth.legs[0].command.includes("clothSoftBodyCrossLanguageParity.test.ts"));
  assert.equal(cloth.legs[1].command.endsWith("--test cloth_softbody_solver_parity"), true);
  assert.ok(hash.legs[0].command.includes("runtimePackageAuthorLod.test.ts"));
  assert.equal(hash.legs[1].command, identity.legs[1].command, "包哈希与身份黄金共用 native 二进制(命令级复用)");
  for (const [id, command] of [["probe-storage-vectors", "node scripts/j2-probe-gi-parity.mjs"],
    ["device-recovery-host-components", "node scripts/j3-device-recovery-parity.mjs"],
    ["geometry-main-depth", "node scripts/j3-geometry-depth-parity.mjs"],
    ["csm-linear-boundary", "node scripts/j2-csm-linear-parity.mjs"]]) {
    const pair = GATE_PAIRS.find(pair => pair.id === id);
    assert.ok(pair.legs.every(leg => leg.requiresGpu && leg.command === command));
  }
});

test("GPU 策略解析:CLI 最后一个生效,其次 env,默认 off", () => {
  assert.equal(resolveGpuPolicy({ argv: [], env: {} }), "off");
  assert.equal(resolveGpuPolicy({ argv: ["--with-gpu"], env: {} }), "auto");
  assert.equal(resolveGpuPolicy({ argv: ["--require-gpu"], env: {} }), "strict");
  assert.equal(resolveGpuPolicy({ argv: ["--gpu-policy=strict"], env: {} }), "strict");
  assert.equal(resolveGpuPolicy({ argv: ["--with-gpu", "--no-gpu"], env: {} }), "off");
  assert.equal(resolveGpuPolicy({ argv: ["--no-gpu", "--require-gpu"], env: {} }), "strict");
  assert.equal(resolveGpuPolicy({ argv: [], env: { J5_GATE_GPU: "on" } }), "auto");
  assert.equal(resolveGpuPolicy({ argv: [], env: { J5_GATE_GPU: "strict" } }), "strict");
  assert.equal(resolveGpuPolicy({ argv: ["--with-gpu"], env: { J5_GATE_GPU: "strict" } }), "auto", "CLI 压过 env");
  assert.throws(() => resolveGpuPolicy({ argv: ["--gpu-policy=bogus"] }), /非法 --gpu-policy/);
});

test("parseArgs:默认超时与覆盖", () => {
  assert.equal(parseArgs([]).gpuPolicy, "off");
  assert.equal(parseArgs(["--with-gpu"]).gpuPolicy, "auto");
  assert.ok(parseArgs([]).timeoutMs > 0);
  assert.equal(parseArgs(["--timeout-ms=1234"]).timeoutMs, 1234);
  assert.throws(() => parseArgs(["--timeout-ms=0"]), /非法 --timeout-ms/);
});

test("全绿路径(policy off):CPU/静态口径降级通过,GPU 腿跳过有原因", () => {
  const { runner, calls } = passRunner();
  const result = executeGate({ gpuPolicy: "off", gpuAvailability: null, runLeg: runner });
  assert.equal(result.ok, true);
  assert.equal(result.degraded, true);
  const cells = result.pairs.flatMap((pair) => pair.cells);
  assert.equal(cells.length, 22, "11 对 × 双腿 = 22 格");
  assert.equal(cells.filter((cell) => cell.status === "PASS").length, 11, "11 条非 GPU 格全绿(含复用格)");
  const tsFurnace = cells.find((cell) => cell.id === "white-furnace:ts-gpu");
  assert.equal(tsFurnace.status, "SKIP");
  assert.match(tsFurnace.detail, /GPU 腿未启用/);
  assert.equal(calls.length, 9, "去重后实际执行 9 条命令(全部为非 GPU 腿)");
});

test("命令级复用:dashboard_identity_golden 只执行一次,两对判据都引用其结果", () => {
  const { runner, calls } = passRunner();
  const result = executeGate({ gpuPolicy: "off", gpuAvailability: null, runLeg: runner });
  const goldenCalls = calls.filter((command) => command.includes("dashboard_identity_golden"));
  assert.equal(goldenCalls.length, 1);
  const identityNative = result.pairs[1].cells.find((cell) => cell.side === "native");
  const hashNative = result.pairs[3].cells.find((cell) => cell.side === "native");
  assert.equal(identityNative.deduped, false);
  assert.equal(hashNative.deduped, true, "第二对标注复用");
  assert.equal(hashNative.status, "PASS");
});

test("任一端红即门失败,且其余腿照常判定(不中断)", () => {
  const { runner } = makeRunner({ statusByNeedle: { cloth_softbody_solver_parity: 1 } });
  const result = executeGate({ gpuPolicy: "off", gpuAvailability: null, runLeg: runner });
  assert.equal(result.ok, false);
  assert.equal(result.failedCells.length, 1);
  assert.equal(result.failedCells[0].id, "cloth-softbody:native");
  const clothPair = result.pairs.find((pair) => pair.id === "cloth-softbody-fingerprint");
  assert.deepEqual(clothPair.failed.map((cell) => cell.side), ["native"]);
  const cells = result.pairs.flatMap((pair) => pair.cells);
  assert.equal(cells.filter((cell) => cell.status === "PASS").length, 10, "其余腿仍 PASS 入表");
  assert.match(formatReport(result), /门判定: FAIL/);
});

test("GPU 腿红同样拦门(auto + adapter 可用 + TS 白炉失败)", () => {
  const { runner } = makeRunner({ statusByNeedle: { "test:white-furnace-gpu": 1 } });
  const result = executeGate({
    gpuPolicy: "auto",
    gpuAvailability: { available: true, reason: "headless Chrome WebGPU adapter 可用" },
    runLeg: runner,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failedCells[0].id, "white-furnace:ts-gpu");
});

test("auto + adapter 不可用:GPU 腿自动跳过并输出原因,CPU 判据保留,门降级通过", () => {
  const { runner, calls } = passRunner();
  const reason = "headless Chrome requestAdapter() 返回空(无可用 GPU adapter)";
  const result = executeGate({ gpuPolicy: "auto", gpuAvailability: { available: false, reason }, runLeg: runner });
  assert.equal(result.ok, true);
  assert.equal(result.degraded, true);
  const tsFurnace = result.pairs[0].cells.find((cell) => cell.id === "white-furnace:ts-gpu");
  assert.equal(tsFurnace.status, "SKIP");
  assert.equal(tsFurnace.detail, reason, "跳过原因必须如实透出探测结论");
  assert.equal(calls.length, 9, "CPU 判据腿照常执行");
  assert.match(formatReport(result), /PASS\(降级\)/);
});

test("strict + adapter 不可用:跳过即门失败(CI 严格档)", () => {
  const { runner } = passRunner();
  const result = executeGate({
    gpuPolicy: "strict",
    gpuAvailability: { available: false, reason: "Chrome 不存在(C:/x/chrome.exe)" },
    runLeg: runner,
  });
  assert.equal(result.ok, false);
  assert.equal(result.strictBlocked, true);
  assert.match(formatReport(result), /strict 策略下 GPU 腿被跳过同样算失败/);
});

test("执行器异常(status null + error)按 FAIL 处理,细节入报告", () => {
  const runner = () => ({ status: null, durationMs: 5, tail: "ETIMEDOUT spawn cargo" });
  const result = executeGate({ gpuPolicy: "off", gpuAvailability: null, runLeg: runner });
  assert.equal(result.ok, false);
  assert.equal(result.failedCells[0].status, "FAIL");
  assert.match(result.failedCells[0].detail, /ETIMEDOUT/);
});

test("executeGate 缺 runLeg 直接抛错(防止静默空跑)", () => {
  assert.throws(() => executeGate({ gpuPolicy: "off", gpuAvailability: null }), /runLeg/);
});

test("报告与证据序列化:九对判据、状态、降级与策略齐全", () => {
  const { runner } = makeRunner({ statusByNeedle: { "test:white-furnace-gpu": 1 } });
  const result = executeGate({
    gpuPolicy: "auto",
    gpuAvailability: { available: true, reason: "headless Chrome WebGPU adapter 可用" },
    runLeg: runner,
  });
  const report = formatReport(result);
  for (const id of GATE_PAIRS.map((pair) => pair.id)) assert.ok(report.includes(`[${id}]`), report);
  const evidence = buildEvidence(result, { date: "2026-09-29T00:00:00.000Z", timeoutMs: 1234 });
  assert.equal(evidence.schema, "deep-engine.j5-dual-end-gate");
  assert.equal(evidence.ok, result.ok);
  assert.equal(evidence.gpuPolicy, "auto");
  assert.equal(evidence.timeoutMs, 1234);
  assert.equal(evidence.pairs.length, 11);
  for (const pair of evidence.pairs) {
    assert.equal(pair.legs.length, 2);
    for (const leg of pair.legs) {
      assert.ok(["PASS", "FAIL", "SKIP"].includes(leg.status));
      assert.ok(typeof leg.command === "string" && leg.command.length > 0);
    }
  }
});

test("strict 模式中新双端 runner 各执行一次，共用本次完整证据", () => {
  const { runner, calls } = passRunner();
  const result = executeGate({ gpuPolicy: "strict", gpuAvailability: { available: true }, runLeg: runner });
  assert.equal(result.ok, true);
  for (const script of ["j2-probe-gi-parity.mjs", "j3-device-recovery-parity.mjs", "j3-geometry-depth-parity.mjs", "j2-csm-linear-parity.mjs"]) {
    assert.equal(calls.filter(command => command.includes(script)).length, 1);
  }
});
