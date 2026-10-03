// F6 接线清单①:布料并行核生产换核的编排与合同测试(无适配器环境,fake device)。
// 证据口径:验证接线语义(dispatch 编排序/缓冲 ABI/回退原因/遥测/host 侧双跑逐位),
// 不是 GPU 数值证据——数值由 A3 锁死(240 tick 指纹 fixture + 真机探针 9.0e-3 m 容差)。串行核零改动。
//
// sourceSizeGate 拆分(2026-10-03):夹具(枚举 shim/fake device/网格与星形输入/期望命令流/
// parity fixture)移至 softBodyGpuDispatch.clothParallel.testUtils.ts,代码逐行同源;
// describe/it 名零变化,语义零变化——外部证据按测试名引用不受影响。
import { beforeEach, describe, expect, it } from "vitest";
import { colorClothConstraints } from "./clothConstraintColoring.js";
import { packClothGpuConstraints, packClothGpuParams, packClothGpuParticles } from "./clothGpuWgsl.js";
import { ClothParallelMirror, buildClothParallelState } from "./clothParallelSolver.js";
import { CLOTH_PARALLEL_PARAMS_BYTES, CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE } from "./clothSolverWgsl.js";
import { dispatchClothGpuStep } from "./softBodyGpuDispatch.js";
import { ClothParallelDispatchError, clothParallelDispatchCount, dispatchClothParallelGpuStep,
  dispatchClothStepAuto, packClothGpuObstacles, resetClothKernelSwitchTelemetry,
  snapshotClothKernelSwitchTelemetry } from "./softBodyGpuDispatch.clothParallel.js";
import { expectedTrace, fakeDevice, gridInput, PARITY_FIXTURE, starInput } from "./softBodyGpuDispatch.clothParallel.testUtils.js";

beforeEach(() => resetClothKernelSwitchTelemetry());

describe("F6 并行核生产换核:编排与 ABI", () => {
  it("12×12 换核成功:单 pass 色序 dispatch 流、缓冲尺寸、dispatchCount = substeps×(2+色数)", async () => {
    const input = gridInput(12, 12, 2);
    const coloring = colorClothConstraints(
      input.constraints.map((c) => c.a), input.constraints.map((c) => c.b), input.particles.length);
    expect(coloring.colorCount).toBe(8); // 与 A3 fixture 同源 12×12 → 8 色
    const { device, buffers, trace } = fakeDevice();
    const result = await dispatchClothParallelGpuStep(device, input);
    const workgroups = Math.ceil(input.particles.length / CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE);
    const colorWorkgroups = coloring.colorRanges.map(([s, e]) => Math.ceil((e - s) / CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE));
    expect(trace).toEqual(expectedTrace(2, workgroups, colorWorkgroups));
    // 缓冲创建序:params 96(风+障碍 ABI)+ 粒子 144×48 + 约束 506×16 + kinetic 3×4 + 8×range 16 + readback。
    expect(buffers.map((b) => b.size)).toEqual([6912, 8096, 96, 12, ...Array.from({ length: 8 }, () => 16), 6912]);
    expect([result.dispatchCount, result.state.byteLength, buffers.every((b) => b.destroyed)])
      .toEqual([clothParallelDispatchCount(2, 8), 144 * 48, true]);
  });

  it("空约束拓扑退化为纯积分:无 project dispatch,dispatchCount = substeps×2", async () => {
    const { device, trace } = fakeDevice();
    const result = await dispatchClothParallelGpuStep(device, { ...gridInput(1, 1, 2), constraints: [] });
    expect(trace).toEqual(expectedTrace(2, 1, []));
    expect([result.colorCount, result.dispatchCount]).toEqual([0, 4]);
  });
});

describe("F6 并行核生产换核:开关语义与遥测", () => {
  it("换核成功:kernel=cloth-parallel,遥测 parallelSteps 增、无回退", async () => {
    const { device } = fakeDevice();
    const result = await dispatchClothStepAuto(device, gridInput(4, 4, 2));
    expect([result.kernel, result.fallbackReason]).toEqual(["cloth-parallel", null]);
    const telemetry = snapshotClothKernelSwitchTelemetry();
    expect([telemetry.parallelSteps, telemetry.serialSteps, telemetry.lastFallbackReason]).toEqual([1, 0, null]);
  });

  it("色序超限(33 星形)fail-closed 回退串行:原因 coloring-unavailable 入遥测", async () => {
    const { device } = fakeDevice();
    const result = await dispatchClothStepAuto(device, starInput(33));
    expect([result.kernel, result.fallbackReason, result.dispatchCount, result.state.byteLength])
      .toEqual(["cloth-serial", "coloring-unavailable", 1, 34 * 48]);
    const telemetry = snapshotClothKernelSwitchTelemetry();
    expect([telemetry.fallbacksByReason["coloring-unavailable"], telemetry.serialSteps, telemetry.parallelSteps]).toEqual([1, 1, 0]);
    // 直接调用并行核:错误对象携带精确 reason(供调用方分类,而非裸异常)。
    const direct: unknown = await dispatchClothParallelGpuStep(fakeDevice().device, starInput(33)).catch((e: unknown) => e);
    expect([direct instanceof ClothParallelDispatchError, (direct as ClothParallelDispatchError).reason])
      .toEqual([true, "coloring-unavailable"]);
  });

  it("shader module 失败回退(串行核不受打击):原因 wgsl-compile-error", async () => {
    const result = await dispatchClothStepAuto(fakeDevice("shader").device, gridInput(2, 2, 1));
    expect([result.kernel, result.fallbackReason]).toEqual(["cloth-serial", "wgsl-compile-error"]);
    expect(snapshotClothKernelSwitchTelemetry().fallbacksByReason["wgsl-compile-error"]).toBe(1);
  });

  it("管线创建失败回退(仅并行入口受打击):原因 gpu-error", async () => {
    const result = await dispatchClothStepAuto(fakeDevice("pipeline").device, gridInput(2, 2, 1));
    expect([result.kernel, result.fallbackReason]).toEqual(["cloth-serial", "gpu-error"]);
    expect(snapshotClothKernelSwitchTelemetry().fallbacksByReason["gpu-error"]).toBe(1);
  });

  it("参数非法是调用方错误:直接上抛,不伪装成回退也不计遥测", async () => {
    const invalid = { ...gridInput(2, 2, 1), substeps: 0 };
    await expect(dispatchClothStepAuto(fakeDevice().device, invalid)).rejects.toThrow(/substeps/);
    const telemetry = snapshotClothKernelSwitchTelemetry();
    expect([telemetry.parallelSteps, telemetry.serialSteps,
      Object.values(telemetry.fallbacksByReason).every((count) => count === 0)]).toEqual([0, 0, true]);
  });

  it("显式 serial 是选择不是回退:fallbackReason=null,计入 serialSteps", async () => {
    const { device } = fakeDevice();
    const result = await dispatchClothStepAuto(device, gridInput(2, 2, 1), { kernel: "serial" });
    expect([result.kernel, result.fallbackReason]).toEqual(["cloth-serial", null]);
    expect(result.state).toEqual((await dispatchClothGpuStep(device, gridInput(2, 2, 1))).state);
    // 遥测只覆盖换核开关面:直连串行 dispatch(不经开关)不计入 serialSteps。
    expect([snapshotClothKernelSwitchTelemetry().serialSteps, snapshotClothKernelSwitchTelemetry().parallelSteps]).toEqual([1, 0]);
    expect(Object.values(snapshotClothKernelSwitchTelemetry().fallbacksByReason).every((count) => count === 0)).toBe(true);
  });
});

describe("F6 并行核生产换核:确定性(host 侧)与量化", () => {
  it("同输入双跑:命令流逐位一致,params/constraints/range 打包字节逐位一致", async () => {
    const input = gridInput(6, 6, 3);
    const first = fakeDevice();
    const second = fakeDevice();
    await Promise.all([
      dispatchClothParallelGpuStep(first.device, input),
      dispatchClothParallelGpuStep(second.device, input),
    ]);
    expect(first.trace).toEqual(second.trace);
    expect(first.buffers.map((b) => b.written)).toEqual(second.buffers.map((b) => b.written));
  });

  it("障碍 ABI:pack 按 WGSL Obstacle 布局落位——center.w=radius、halfExtents 在槽16..18、判别式槽19(sphere>0/cuboid=0)", () => {
    // C8 定位批回归锁:旧实现把 halfExtents 写槽 13..15 且判别式恒 0,sphere 被当
    // 零尺寸 cuboid → projectObstacles 静默无效应(真机逐子步定位 softbody-divergence)。
    const sphere = { center: [0.55, 0.5, 0.05] as const, radius: 0.45,
      rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] as const, halfExtents: [0, 0, 0] as const };
    const cuboid = { center: [1, 2, 3] as const, radius: 0,
      rotation: [0, 1, 0, 0, 0, 1, 1, 0, 0] as const, halfExtents: [0.2, 0.3, 0.4] as const };
    const packed = new Float32Array(packClothGpuObstacles([sphere, cuboid]));
    const expectRow = (index: number, row: number[]) =>
      expect(Array.from(packed.subarray(index * 20, index * 20 + 20))).toEqual(row.map(Math.fround));
    // sphere:槽 0..3=center+radius;槽 4..12=rotation 行主序;槽 16..18=halfExtents.xyz;槽 19=判别式>0。
    expectRow(0, [0.55, 0.5, 0.05, 0.45, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0.45]);
    // cuboid:radius=0 → 判别式槽 19=0(WGSL else 分支),halfExtents.xyz 在槽 16..18。
    expectRow(1, [1, 2, 3, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0.2, 0.3, 0.4, 0]);
    // 判别式恒式:sphere 槽 19 与 center.w(槽 3)同值(都是 radius)。
    expect(packed[19]).toBe(packed[3]);
    expect(packed[39]).toBe(0);
  });

  it("桶序 ABI:约束缓冲=着色桶序、range uniform=colorRanges、params 槽3=colorCount", async () => {
    const input = gridInput(6, 6, 1);
    const { device, buffers } = fakeDevice();
    await dispatchClothParallelGpuStep(device, input);
    const [, constraintBuffer, paramsBuffer, , ...rangeBuffersAll] = buffers;
    const coloring = colorClothConstraints(
      input.constraints.map((c) => c.a), input.constraints.map((c) => c.b), input.particles.length);
    const rangeBuffers = rangeBuffersAll.slice(0, coloring.colorCount); // 末尾是 readback,不属于 range 段。
    const expected = new ArrayBuffer(input.constraints.length * 16);
    const ints = new Uint32Array(expected);
    const floats = new Float32Array(expected);
    for (const bucket of coloring.order.keys()) {
      const constraint = input.constraints[coloring.order[bucket]!]!;
      ints[bucket * 4] = constraint.a; ints[bucket * 4 + 1] = constraint.b;
      floats[bucket * 4 + 2] = Math.fround(constraint.restLength);
    }
    expect(constraintBuffer!.written).toEqual(expected);
    expect(new Uint32Array(paramsBuffer!.written!)[3]).toBe(coloring.colorCount);
    expect(paramsBuffer!.size).toBe(CLOTH_PARALLEL_PARAMS_BYTES);
    rangeBuffers.forEach((buffer, color) => {
      const [start, end] = coloring.colorRanges[color]!;
      expect(Array.from(new Uint32Array(buffer.written!))).toEqual([start, end, 0, 0]);
    });
  });

  it("接线不破镜像确定性:穿插换核成功/回退前后,镜像指纹仍逐位且钉 fixture", async () => {
    const gridConfig = {
      columns: 12, rows: 12, spacing: 0.1, mass: 0.2, gravity: [0, -9.81, 0] as const,
      dtSeconds: 1 / 60, substeps: 8, compliance: 0, damping: 0.01, perturbation: 0.005,
      seed: 20260927, origin: [0, 0, 0] as const, pinned: [[0, 11], [11, 11]] as const,
    };
    const isolate = new ClothParallelMirror(buildClothParallelState(gridConfig));
    const wired = new ClothParallelMirror(buildClothParallelState(gridConfig));
    const { device } = fakeDevice();
    const fingerprints: string[] = [];
    for (let tick = 1; tick <= 48; tick += 1) {
      isolate.step();
      wired.step();
      // 每 tick 穿插一次换核成功(并行)与一次回退(超限星形),接线不触碰镜像状态。
      await dispatchClothStepAuto(device, gridInput(4, 4, 2));
      await dispatchClothStepAuto(device, starInput(33));
      if (tick % 24 === 0) fingerprints.push(wired.stateFingerprint32());
    }
    expect(fingerprints).toEqual([PARITY_FIXTURE.replay.fingerprints.per24[0], PARITY_FIXTURE.replay.fingerprints.per24[1]]);
    expect(wired.captureState()).toEqual(isolate.captureState());
    const telemetry = snapshotClothKernelSwitchTelemetry();
    expect([telemetry.parallelSteps, telemetry.fallbacksByReason["coloring-unavailable"]]).toEqual([48, 48]);
  });

  it("量化:并行 80 dispatch/tick vs 串行 1(12×12,8 substeps);host 准备成本对照", async () => {
    const input = gridInput(12, 12, 8);
    expect(clothParallelDispatchCount(8, 8)).toBe(80);
    const { device, trace } = fakeDevice();
    const result = await dispatchClothStepAuto(device, input);
    expect(result.dispatchCount).toBe(80);
    expect(trace.filter((entry) => entry.startsWith("dispatch:"))).toHaveLength(80);
    // host 侧准备成本(着色+打包,不含命令编码与 GPU 执行;GPU 帧时为真机项,未测):
    const parallelPrepStart = performance.now();
    for (let i = 0; i < 200; i += 1) {
      const coloring = colorClothConstraints(
        input.constraints.map((c) => c.a), input.constraints.map((c) => c.b), input.particles.length);
      void packClothGpuConstraints(Array.from(coloring.order, (k) => input.constraints[k]!), input.particles.length);
      void packClothGpuParticles(input.particles);
    }
    const parallelPrepMs = (performance.now() - parallelPrepStart) / 200;
    const serialPrepStart = performance.now();
    for (let i = 0; i < 200; i += 1) {
      void packClothGpuParticles(input.particles);
      void packClothGpuConstraints(input.constraints, input.particles.length);
      void packClothGpuParams(input);
    }
    const serialPrepMs = (performance.now() - serialPrepStart) / 200;
    console.log(`[quant] 12x12x8substeps dispatch/tick: parallel=${clothParallelDispatchCount(8, 8)} serial=1; ` +
      `host prep ms/tick: parallel=${parallelPrepMs.toFixed(3)} serial=${serialPrepMs.toFixed(3)}`);
    expect(parallelPrepMs).toBeLessThan(5);
    expect(serialPrepMs).toBeLessThan(5);
  });
});
