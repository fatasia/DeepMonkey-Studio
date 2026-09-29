import { describe, expect, it } from "vitest";
import { classifyDeviceLost, classifyUncapturedError, DeviceRecoveryStateMachine,
  type GpuErrorClassification } from "./deviceRecovery.js";

const codes = (machine: DeviceRecoveryStateMachine) => machine.events.map((event) => event.code ?? event.message);

describe("GPU error classification (C13 分型)", () => {
  it("types device.lost reasons: unknown is recoverable, destroyed is not", () => {
    expect(classifyDeviceLost("unknown", "driver reset")).toEqual({
      code: "device-lost/unknown", recoverable: true, message: "driver reset" });
    expect(classifyDeviceLost("destroyed", "intentional")).toEqual({
      code: "device-lost/destroyed", recoverable: false, message: "intentional" });
  });
  it("falls back to an unknown recoverable loss when the reason is missing", () => {
    const classified = classifyDeviceLost(undefined, "");
    expect(classified.code).toBe("device-lost/unknown");
    expect(classified.recoverable).toBe(true);
    expect(classified.message).not.toBe("");
  });
  it("types uncaptured errors across both naming schemes of GPUError.name", () => {
    const typed = (name: string): GpuErrorClassification => classifyUncapturedError({ name, message: `boom ${name}` });
    expect(typed("GPUOutOfMemoryError").code).toBe("uncaptured/out-of-memory");
    expect(typed("out-of-memory").recoverable).toBe(true);
    expect(typed("GPUValidationError").code).toBe("uncaptured/validation");
    expect(typed("validation").recoverable).toBe(false);
    expect(typed("GPUInternalError").code).toBe("uncaptured/internal");
    expect(typed("GPUInternalError").recoverable).toBe(true);
    // 无法归类的错误保守映射为 validation 形（不自动恢复），且不丢原文。
    const mystery = typed("SomethingElse");
    expect(mystery.code).toBe("uncaptured/validation");
    expect(mystery.message).toContain("SomethingElse");
  });
});

describe("DeviceRecoveryStateMachine", () => {
  it("walks the documented healthy -> recovering -> healthy cycle and bumps the epoch", () => {
    const machine = new DeviceRecoveryStateMachine();
    expect(machine.snapshot).toMatchObject({ phase: "healthy", epoch: 0, attempts: 0 });
    expect(machine.noteClassified(classifyDeviceLost("unknown", "reset"))).toBe("recover");
    machine.beginRecovery();
    expect(machine.phase).toBe("recovering");
    machine.recordRecovered();
    expect(machine.snapshot).toMatchObject({ phase: "healthy", epoch: 1, attempts: 0, lastCode: "device-lost/unknown" });
  });
  it("retries with exponential backoff and reports exhaustion at maxAttempts", () => {
    const machine = new DeviceRecoveryStateMachine({ maxAttempts: 3, backoffMs: 100, maxBackoffMs: 250 });
    machine.beginRecovery();
    expect(machine.recordAttemptFailure("recovery/adapter-unavailable", "attempt 1")).toEqual({ action: "retry", backoffMs: 100 });
    expect(machine.recordAttemptFailure("recovery/adapter-unavailable", "attempt 2")).toEqual({ action: "retry", backoffMs: 200 });
    expect(machine.recordAttemptFailure("recovery/adapter-unavailable", "attempt 3")).toEqual({ action: "exhausted" });
    machine.declareFatal("recovery/exhausted", "gave up");
    expect(machine.snapshot).toMatchObject({ phase: "lost", attempts: 3, maxAttempts: 3, lastMessage: "gave up" });
  });
  it("caps backoff at maxBackoffMs", () => {
    const machine = new DeviceRecoveryStateMachine({ maxAttempts: 4, backoffMs: 1000, maxBackoffMs: 1500 });
    machine.beginRecovery();
    expect(machine.recordAttemptFailure("recovery/adapter-unavailable", "1")).toMatchObject({ backoffMs: 1000 });
    expect(machine.recordAttemptFailure("recovery/adapter-unavailable", "2")).toMatchObject({ backoffMs: 1500 });
  });
  it("keeps validation errors in degraded without counting a recovery attempt, then recovers from degraded", () => {
    const machine = new DeviceRecoveryStateMachine();
    expect(machine.noteClassified(classifyUncapturedError({ name: "GPUValidationError", message: "bad pipeline" }))).toBe("degrade");
    machine.degrade();
    expect(machine.snapshot).toMatchObject({ phase: "degraded", attempts: 0 });
    machine.noteClassified(classifyDeviceLost("unknown", "reset"));
    machine.beginRecovery();
    machine.recordRecovered();
    expect(machine.phase).toBe("healthy");
  });
  it("ignores events after the lost terminal state and keeps declareFatal idempotent", () => {
    const machine = new DeviceRecoveryStateMachine();
    machine.beginRecovery();
    machine.declareFatal("recovery/exhausted", "first");
    expect(machine.noteClassified(classifyDeviceLost("unknown", "late"))).toBe("ignore");
    machine.declareFatal("recovery/exhausted", "second");
    expect(codes(machine).filter((code) => code === "recovery/exhausted").length).toBe(1);
  });
  it("throws on illegal transitions instead of drifting silently", () => {
    const machine = new DeviceRecoveryStateMachine();
    expect(() => machine.recordRecovered()).toThrow(/Illegal device recovery transition: healthy/);
    const degraded = new DeviceRecoveryStateMachine();
    degraded.degrade();
    expect(() => degraded.degrade()).toThrow(/degraded --\(degrade\)/);
    const recovering = new DeviceRecoveryStateMachine();
    recovering.beginRecovery();
    expect(() => recovering.beginRecovery()).toThrow(/recovering --\(recovering\)/);
  });
  it("rejects malformed recovery options", () => {
    expect(() => new DeviceRecoveryStateMachine({ maxAttempts: 0 })).toThrow(/maxAttempts/);
    expect(() => new DeviceRecoveryStateMachine({ backoffMs: Number.NaN })).toThrow(/backoffMs/);
  });
  it("keeps a bounded audit trail with ordered seq and phase snapshots", () => {
    const machine = new DeviceRecoveryStateMachine();
    machine.noteClassified(classifyDeviceLost("unknown", "reset"));
    machine.beginRecovery();
    machine.recordRecovered();
    // 每次状态迁移都留痕：进入 recovering 与回到 healthy 各一条 state 事件。
    const types = machine.events.map((event) => event.type);
    expect(types).toEqual(["classified", "state", "state", "recovered"]);
    expect(machine.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(machine.events[0]).toMatchObject({ phase: "healthy", code: "device-lost/unknown" });
    expect(machine.events[1]).toMatchObject({ phase: "recovering", message: "recovering" });
    expect(machine.events[2]).toMatchObject({ phase: "healthy", message: "healthy" });
  });
});
