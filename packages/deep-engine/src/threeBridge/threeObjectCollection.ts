import type { ThreeObjectSource } from "./types.js";

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * 创建只读虚拟 Group，把多个作者根节点作为一个投影输入。
 * 它不会 reparent、clone、update 或 dispose Three 对象。
 */
export function threeObjectCollection(children: readonly ThreeObjectSource[]): ThreeObjectSource {
  return Object.freeze({
    children: Object.freeze([...children]),
    visible: true,
    layers: Object.freeze({ mask: -1 }),
    matrixWorld: Object.freeze({ elements: IDENTITY }),
    type: "Group",
    renderOrder: 0,
  });
}
