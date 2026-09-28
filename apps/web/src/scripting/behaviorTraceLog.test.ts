import { describe, expect, it } from "vitest";
import {
  BehaviorTraceLog,
  MonotonicBehaviorClock,
  summarizeTraceValue,
} from "./behaviorTraceLog";

describe("BehaviorTraceLog 有界环形缓冲", () => {
  it("append 分配单调 seq;snapshot 为时间序深拷贝", () => {
    const log = new BehaviorTraceLog();
    const first = log.append({ atMs: 0, graphId: "g", eventNodeId: "e1", outcome: "applied" });
    const second = log.append({ atMs: 10, graphId: "g", eventNodeId: "e2", outcome: "applied" });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    const snapshot = log.snapshot();
    expect(snapshot.map((entry) => entry.seq)).toStrictEqual([1, 2]);
    // 深拷贝:每次 snapshot 返回独立对象,外部持有没有缓冲内部引用。
    expect(log.snapshot()[0]).not.toBe(snapshot[0]);
    expect(log.snapshot()).toStrictEqual(snapshot);
  });

  it("容量溢出丢最旧,dropped 计数,lastSeq 不回退", () => {
    const log = new BehaviorTraceLog({ capacity: 8 });
    for (let index = 1; index <= 10; index += 1) {
      log.append({ atMs: index, graphId: "g", eventNodeId: `e${index}`, outcome: "applied" });
    }
    expect(log.size).toBe(8);
    expect(log.dropped).toBe(2);
    expect(log.lastSeq).toBe(10);
    const remaining = log.snapshot().map((entry) => entry.seq);
    expect(remaining).toStrictEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("容量夹取:非法值回退默认 512,上限 4096", () => {
    expect(new BehaviorTraceLog({ capacity: Number.NaN }).size).toBe(0);
    const big = new BehaviorTraceLog({ capacity: 1_000_000 });
    for (let index = 0; index < 4_200; index += 1) {
      big.append({ atMs: index, graphId: "g", eventNodeId: "e", outcome: "applied" });
    }
    expect(big.size).toBe(4_096);
  });

  it("clear 只清缓冲,seq 连续性与 dropped 不变", () => {
    const log = new BehaviorTraceLog();
    log.append({ atMs: 0, graphId: "g", eventNodeId: "e", outcome: "applied" });
    log.clear();
    expect(log.size).toBe(0);
    expect(log.lastSeq).toBe(1);
    const next = log.append({ atMs: 5, graphId: "g", eventNodeId: "e", outcome: "applied" });
    expect(next.seq).toBe(2);
  });
});

describe("MonotonicBehaviorClock 注入时钟", () => {
  it("advance 只接受正有限值;nowMs 确定累计", () => {
    const clock = new MonotonicBehaviorClock();
    expect(clock.nowMs()).toBe(0);
    clock.advance(16.5);
    clock.advance(0);
    clock.advance(-3);
    clock.advance(Number.NaN);
    expect(clock.nowMs()).toBe(16.5);
    clock.advance(3.5);
    expect(clock.nowMs()).toBe(20);
  });
});

describe("轨迹确定性", () => {
  it("同时钟同追加序列 → 同日志序列(逐字段全等)", () => {
    const build = (): BehaviorTraceLog => {
      const clock = new MonotonicBehaviorClock();
      const log = new BehaviorTraceLog({ clock });
      for (const delta of [16, 16, 16]) {
        clock.advance(delta);
        log.append({ atMs: clock.nowMs(), graphId: "g", eventNodeId: "e", action: "animate", target: "m1", before: "1", after: "2", outcome: "applied" });
      }
      return log;
    };
    expect(build().snapshot()).toStrictEqual(build().snapshot());
  });
});

describe("summarizeTraceValue 确定性摘要", () => {
  it("对象键按字典序排列,与插入序无关", () => {
    expect(summarizeTraceValue({ b: 1, a: 2 })).toBe(summarizeTraceValue({ a: 2, b: 1 }));
    expect(summarizeTraceValue({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("基础类型:string 引号包裹,undefined 显式可辨", () => {
    expect(summarizeTraceValue("高")).toBe('"高"');
    expect(summarizeTraceValue(42)).toBe("42");
    expect(summarizeTraceValue(null)).toBe("null");
    expect(summarizeTraceValue(undefined)).toBe("undefined");
    expect(summarizeTraceValue(Number.NaN)).toBe("NaN");
  });

  it("超长截断并携带原始长度", () => {
    const long = "x".repeat(500);
    const summary = summarizeTraceValue(long);
    expect(summary.startsWith('"')).toBe(true);
    expect(summary).toContain(`…(${500 + 2})`);
    expect(summary.length).toBeLessThan(160);
  });
});
