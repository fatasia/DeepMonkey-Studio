import { describe, expect, it } from "vitest";
import { PhysicsPoseRecorder, parsePhysicsPoseJson } from "./physicsPoseRecorder";

const pose = (p: [number, number, number], q: [number, number, number, number] = [0, 0, 0, 1]) => ({
  bodies: [
    { id: "box-a", p, q },
    { id: "box-b", p: [p[0] + 1, p[1], p[2]] as [number, number, number], q },
  ],
});

describe("PhysicsPoseRecorder 环形缓冲", () => {
  it("容量内按序保留全部帧", () => {
    const recorder = new PhysicsPoseRecorder(4);
    for (let step = 1; step <= 3; step += 1) recorder.recordFrame({ step, bodies: pose([step, 0, 0]).bodies });
    expect(recorder.size).toBe(3);
    expect(recorder.framesAscending().map((frame) => frame.step)).toEqual([1, 2, 3]);
  });

  it("超过容量时丢弃最早帧并保持容量上限", () => {
    const recorder = new PhysicsPoseRecorder(3);
    for (let step = 1; step <= 7; step += 1) recorder.recordFrame({ step, bodies: pose([step, 0, 0]).bodies });
    expect(recorder.size).toBe(3);
    expect(recorder.framesAscending().map((frame) => frame.step)).toEqual([5, 6, 7]);
  });

  it("帧数据深拷贝，外部改写不污染缓冲", () => {
    const recorder = new PhysicsPoseRecorder(2);
    const bodies = pose([1, 2, 3]).bodies;
    recorder.recordFrame({ step: 1, bodies });
    (bodies[0]!.p as unknown as number[])[0] = 999;
    expect(recorder.framesAscending()[0]!.bodies[0]!.p).toEqual([1, 2, 3]);
  });

  it("拒绝非正容量", () => {
    expect(() => new PhysicsPoseRecorder(0)).toThrow("录制容量");
  });
});

describe("T17 位姿 JSON 导出", () => {
  it("导出结构含 meta.steps/meta.boxes 且可直接被比较脚本形态消费", () => {
    const recorder = new PhysicsPoseRecorder(600);
    recorder.recordFrame({ step: 10, bodies: pose([0.1, 0.2, 0.3]).bodies });
    const json = recorder.toPoseJson({ end: "web", scenario: "unit", fixedStepSeconds: 1 / 60 });
    expect(json.meta.end).toBe("web");
    expect(json.meta.steps).toBe(1);
    expect(json.meta.boxes).toEqual(["box-a", "box-b"]);
    expect(json.poses[0]![0]).toEqual({ p: [0.1, 0.2, 0.3], q: [0, 0, 0, 1] });
    expect(json.poses[0]![1]!.p).toEqual([1.1, 0.2, 0.3]);
  });

  it("空录制导出报错", () => {
    const recorder = new PhysicsPoseRecorder(10);
    expect(() => recorder.toPoseJson({})).toThrow("没有已录制的位姿帧");
  });
});

describe("parsePhysicsPoseJson", () => {
  it("往返：导出 → 解析还原同一序列", () => {
    const recorder = new PhysicsPoseRecorder(600);
    recorder.recordFrame({ step: 1, bodies: pose([0, 0, 0]).bodies });
    recorder.recordFrame({ step: 2, bodies: pose([0.5, 0, 0]).bodies });
    const parsed = parsePhysicsPoseJson(JSON.stringify(recorder.toPoseJson({ end: "native" })), "native.json");
    expect(parsed.end).toBe("native");
    expect(parsed.steps).toBe(2);
    expect(parsed.bodies).toEqual(["box-a", "box-b"]);
    expect(parsed.frames[1]!.bodies[0]!.p).toEqual([0.5, 0, 0]);
  });

  it("解析 T17 既有落盘数据（真实格式回归）", () => {
    const payload = {
      meta: { end: "web", rapier: "0.19.3", scenario: "stack-3boxes", steps: 2, boxes: ["s1", "s2", "s3"] },
      poses: [
        [{ p: [0, 0.1, 0], q: [0, 0, 0, 1] }, { p: [0, 0.3, 0], q: [0, 0, 0, 1] }, { p: [0, 0.5, 0], q: [0, 0, 0, 1] }],
        [{ p: [0.001, 0.1, 0], q: [0, 0, 0.001, 1] }, { p: [0, 0.3, 0], q: [0, 0, 0, 1] }, { p: [0, 0.5, 0], q: [0, 0, 0, 1] }],
      ],
    };
    const parsed = parsePhysicsPoseJson(JSON.stringify(payload), "web-stack-poses.json");
    expect(parsed.frames).toHaveLength(2);
    expect(parsed.frames[0]!.bodies[2]!.id).toBe("s3");
  });

  it("非法输入逐项报错（非 JSON / 缺 meta / poses 空 / boxes 缺 / 步内数量不一致 / p 非法）", () => {
    expect(() => parsePhysicsPoseJson("not json", "a.json")).toThrow("不是合法 JSON");
    expect(() => parsePhysicsPoseJson("{}", "a.json")).toThrow("meta");
    expect(() => parsePhysicsPoseJson(JSON.stringify({ meta: { boxes: ["x"] }, poses: [] }), "a.json")).toThrow("poses");
    expect(() => parsePhysicsPoseJson(JSON.stringify({ meta: {}, poses: [[{ p: [0, 0, 0], q: [0, 0, 0, 1] }]] }), "a.json")).toThrow("boxes");
    expect(() => parsePhysicsPoseJson(JSON.stringify({
      meta: { boxes: ["a", "b"] },
      poses: [[{ p: [0, 0, 0], q: [0, 0, 0, 1] }]],
    }), "a.json")).toThrow("不一致");
    expect(() => parsePhysicsPoseJson(JSON.stringify({
      meta: { boxes: ["a"] },
      poses: [[{ p: [0, 0], q: [0, 0, 0, 1] }]],
    }), "a.json")).toThrow("p/q");
  });
});
