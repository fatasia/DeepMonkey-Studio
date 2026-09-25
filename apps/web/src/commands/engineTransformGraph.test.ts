import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { SceneTransformGraphError } from "@bim-studio/deep-engine/scene";
import {
  EngineTransformAuthoring,
  eulerXyzToQuaternion,
  modelTransformToSceneLocalTrs,
  transformGraphNodeId,
} from "./engineTransformGraph";

const transform = {
  position: { x: 10, y: -4.5, z: 30.25 },
  rotation: { x: 0.1, y: Math.PI / 2, z: -0.75 },
  scale: { x: 2, y: 0.5, z: 3 },
};

function expectMatrixClose(actual: readonly number[], expected: THREE.Matrix4, epsilon = 1e-9): void {
  const elements = expected.toArray();
  expect(actual.length).toBe(16);
  for (let index = 0; index < 16; index += 1) {
    expect(Math.abs(actual[index]! - elements[index]!)).toBeLessThan(epsilon);
  }
}

describe("eulerXyzToQuaternion(与 THREE.Quaternion.setFromEuler XYZ 序对拍)", () => {
  it("常规角度组合下逐分量一致(1e-12)", () => {
    const cases = [
      [0, 0, 0],
      [Math.PI / 2, 0, 0],
      [0.1, Math.PI / 2, -0.75],
      [-Math.PI, Math.PI / 3, Math.PI / 6],
    ] as const;
    for (const [x, y, z] of cases) {
      const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, "XYZ"));
      const actual = eulerXyzToQuaternion(x, y, z);
      const expectedComponents = [expected.x, expected.y, expected.z, expected.w] as const;
      for (let index = 0; index < 4; index += 1) {
        expect(Math.abs(actual[index]! - expectedComponents[index]!)).toBeLessThan(1e-12);
      }
    }
  });
});

describe("transformGraphNodeId(命令 target 与 graph 节点一一对应)", () => {
  it("模型根与图层对象命名空间隔离", () => {
    expect(transformGraphNodeId("m1")).toBe("model:m1");
    expect(transformGraphNodeId("m1", "l2")).toBe("layer:m1:l2");
    expect(transformGraphNodeId("m1")).not.toBe(transformGraphNodeId("m1", "l2"));
  });
});

describe("modelTransformToSceneLocalTrs(平移/缩放浮点透传,不引入换算误差)", () => {
  it("translation/scale 逐位相等;rotation 为命令欧拉角的 XYZ 四元数", () => {
    const trs = modelTransformToSceneLocalTrs(transform);
    expect(trs.kind).toBe("trs");
    expect(trs.translation).toEqual([10, -4.5, 30.25]);
    expect(trs.scale).toEqual([2, 0.5, 3]);
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(transform.rotation.x, transform.rotation.y, transform.rotation.z, "XYZ"));
    expect(trs.rotation[0]).toBeCloseTo(quaternion.x, 12);
    expect(trs.rotation[3]).toBeCloseTo(quaternion.w, 12);
  });
});

describe("EngineTransformAuthoring(graph 权威通道行为)", () => {
  it("首次命令 create:changed、graphRevision 推进、worldMatrix 与 THREE compose 一致", () => {
    const authoring = new EngineTransformAuthoring();
    const result = authoring.applySetTransform("model:m1", transform);

    expect(result.changed).toBe(true);
    expect(result.graphRevision).toBe(1);
    const expected = new THREE.Matrix4().compose(
      new THREE.Vector3(transform.position.x, transform.position.y, transform.position.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(transform.rotation.x, transform.rotation.y, transform.rotation.z, "XYZ")),
      new THREE.Vector3(transform.scale.x, transform.scale.y, transform.scale.z),
    );
    expectMatrixClose(result.worldMatrix, expected);

    const node = authoring.node("model:m1");
    expect(node?.localTransform.kind).toBe("trs");
    expect(node?.lastChangedRevision).toBe(0);
  });

  it("同节点二次命令 update 覆盖:新值生效、revision 单调推进", () => {
    const authoring = new EngineTransformAuthoring();
    authoring.applySetTransform("model:m1", transform);
    const moved = { ...transform, position: { x: 5, y: 6, z: 7 } };
    const second = authoring.applySetTransform("model:m1", moved);

    expect(second.changed).toBe(true);
    expect(second.graphRevision).toBe(2);
    expect(authoring.node("model:m1")?.localTransform).toMatchObject({ translation: [5, 6, 7] });
  });

  it("同值重发为 no-op:changed=false、graphRevision 不推进(与总线 revision 相互独立)", () => {
    const authoring = new EngineTransformAuthoring();
    authoring.applySetTransform("model:m1", transform);
    const repeat = authoring.applySetTransform("model:m1", { ...transform });

    expect(repeat.changed).toBe(false);
    expect(repeat.graphRevision).toBe(1);
  });

  it("不同节点互不干扰:model 与 layer 命名空间各自记账", () => {
    const authoring = new EngineTransformAuthoring();
    authoring.applySetTransform("model:m1", transform);
    authoring.applySetTransform("layer:m1:l2", { ...transform, scale: { x: 1, y: 1, z: 1 } });

    expect(authoring.node("model:m1")?.localTransform).toMatchObject({ scale: [2, 0.5, 3] });
    expect(authoring.node("layer:m1:l2")?.localTransform).toMatchObject({ scale: [1, 1, 1] });
    expect(authoring.revision).toBe(2);
  });

  it("非法值 fail-fast:非有限平移/缩放抛 SceneTransformGraphError,graph 状态不留脏值", () => {
    const authoring = new EngineTransformAuthoring();
    authoring.applySetTransform("model:m1", transform);
    expect(() =>
      authoring.applySetTransform("model:m1", { ...transform, position: { x: Number.POSITIVE_INFINITY, y: 0, z: 0 } }),
    ).toThrow(SceneTransformGraphError);
    expect(() =>
      authoring.applySetTransform("model:m1", { ...transform, scale: { x: Number.NaN, y: 1, z: 1 } }),
    ).toThrow(SceneTransformGraphError);
    // 失败命令不污染通道:graph 仍持上一次成功值,revision 未推进。
    expect(authoring.node("model:m1")?.localTransform).toMatchObject({ translation: [10, -4.5, 30.25] });
    expect(authoring.revision).toBe(1);
  });
});
