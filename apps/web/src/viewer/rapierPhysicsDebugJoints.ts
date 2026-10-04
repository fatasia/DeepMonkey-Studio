import * as THREE from "three";

/**
 * T0 刀 3 物理调试可视化：约束（关节）轴线与限位图层。
 * 数据（世界锚点/世界轴/行程/限位状态）由宿主按帧组装为纯数据条目，
 * 本模块只做几何构建与渲染同步，可在 headless 环境直接单测。
 *
 * 语义：轴线与行程指示=黄（0xffd54f）；限位刻度=灰（0xb0bec5）、
 * 触限（at-limit）转红（0xef5350）。与面板图例同值。
 */

/** 关节调试条目（世界系，纯数据）。 */
export interface PhysicsDebugJointViz {
  readonly id: string;
  readonly kind: "revolute" | "prismatic";
  /** 世界系锚点：从动刚体当前世界位置（枢轴跟随运动体，排错时最直观）。 */
  readonly anchor: { x: number; y: number; z: number };
  /** 世界系单位轴方向：axis 经连接体（或世界）帧旋转。 */
  readonly axis: { x: number; y: number; z: number };
  readonly limits: { readonly enabled: boolean; readonly min: number; readonly max: number };
  /** revolute=rad，prismatic=m。 */
  readonly travel: number;
  readonly limitState: "disabled" | "within" | "at-limit";
}

export interface PhysicsJointDebugLayer {
  readonly object: THREE.Group;
  setVisible(visible: boolean): void;
  sync(joints: readonly PhysicsDebugJointViz[]): void;
  dispose(): void;
}

const AXIS_HALF_LENGTH = 0.4;
const RADIAL_LENGTH = 0.28;
const PRISM_TICK_LENGTH = 0.1;

/** 调试语义色（数字常量为唯一事实来源；面板图例经 hex 换算同值展示）。 */
export const PHYSICS_DEBUG_JOINT_COLORS = { axis: 0xffd54f, limit: 0xb0bec5, atLimit: 0xef5350 } as const;

const COLOR_AXIS = new THREE.Color(PHYSICS_DEBUG_JOINT_COLORS.axis);
const COLOR_LIMIT = new THREE.Color(PHYSICS_DEBUG_JOINT_COLORS.limit);
const COLOR_AT_LIMIT = new THREE.Color(PHYSICS_DEBUG_JOINT_COLORS.atLimit);

/** 每关节最多线段端点数：轴线 2 + 行程 2 + 限位 2×2。 */
const VERTICES_PER_JOINT = 8;

export function createPhysicsJointDebugLayer(): PhysicsJointDebugLayer {
  const object = new THREE.Group();
  object.name = "helper:physics-joint-debug";
  object.visible = false;
  const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
  let positions = new Float32Array(VERTICES_PER_JOINT * 3 * 64);
  let colors = new Float32Array(VERTICES_PER_JOINT * 3 * 64);
  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(positions, 3);
  const colorAttribute = new THREE.BufferAttribute(colors, 3);
  positionAttribute.setUsage(THREE.DynamicDrawUsage);
  colorAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positionAttribute);
  geometry.setAttribute("color", colorAttribute);
  geometry.setDrawRange(0, 0);
  const lines = new THREE.LineSegments(geometry, material);
  lines.name = "helper:physics-joint-debug:lines";
  lines.renderOrder = 10_001;
  lines.raycast = () => {};
  lines.frustumCulled = false;
  object.add(lines);

  return {
    object,
    setVisible(visible) {
      object.visible = visible;
    },
    sync(joints) {
      const capacity = positions.length / 3 / VERTICES_PER_JOINT;
      if (joints.length > capacity) {
        // Float32Array 不可原位扩容：重建缓冲并重绑 attribute（关节超 64 的场景才发生）。
        positions = new Float32Array(joints.length * VERTICES_PER_JOINT * 3);
        colors = new Float32Array(joints.length * VERTICES_PER_JOINT * 3);
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
        geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
      }
      let vertex = 0;
      const write = (x: number, y: number, z: number, color: THREE.Color) => {
        const base = vertex * 3;
        positions[base] = x; positions[base + 1] = y; positions[base + 2] = z;
        colors[base] = color.r; colors[base + 1] = color.g; colors[base + 2] = color.b;
        vertex += 1;
      };
      const segment = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, color: THREE.Color) => {
        write(ax, ay, az, color);
        write(bx, by, bz, color);
      };
      for (const joint of joints) {
        const { anchor, axis } = joint;
        // 主轴线：锚点两侧对称延伸（黄）。
        segment(
          anchor.x - axis.x * AXIS_HALF_LENGTH, anchor.y - axis.y * AXIS_HALF_LENGTH, anchor.z - axis.z * AXIS_HALF_LENGTH,
          anchor.x + axis.x * AXIS_HALF_LENGTH, anchor.y + axis.y * AXIS_HALF_LENGTH, anchor.z + axis.z * AXIS_HALF_LENGTH,
          COLOR_AXIS,
        );
        const limitColor = joint.limitState === "at-limit" ? COLOR_AT_LIMIT : COLOR_LIMIT;
        if (joint.kind === "revolute") {
          const reference = perpendicularOf(axis);
          // 行程径向指针（黄）：装配零位起、绕轴转过 travel 的当前位置。
          const travelDirection = rotatedRadial(reference, axis, joint.travel);
          segment(anchor.x, anchor.y, anchor.z,
            anchor.x + travelDirection.x * RADIAL_LENGTH, anchor.y + travelDirection.y * RADIAL_LENGTH, anchor.z + travelDirection.z * RADIAL_LENGTH,
            COLOR_AXIS);
          if (joint.limits.enabled) {
            for (const limitAngle of [joint.limits.min, joint.limits.max]) {
              const direction = rotatedRadial(reference, axis, limitAngle);
              segment(anchor.x, anchor.y, anchor.z,
                anchor.x + direction.x * RADIAL_LENGTH, anchor.y + direction.y * RADIAL_LENGTH, anchor.z + direction.z * RADIAL_LENGTH,
                limitColor);
            }
          }
        } else {
          // prismatic：行程沿轴偏移的短刻度（黄）；限位为轴上两道垂直刻度（灰/红）。
          const travelOffset = joint.limits.enabled
            ? Math.min(Math.max(joint.travel, joint.limits.min), joint.limits.max)
            : joint.travel;
          segment(
            anchor.x + axis.x * travelOffset - axis.x * PRISM_TICK_LENGTH,
            anchor.y + axis.y * travelOffset - axis.y * PRISM_TICK_LENGTH,
            anchor.z + axis.z * travelOffset - axis.z * PRISM_TICK_LENGTH,
            anchor.x + axis.x * travelOffset + axis.x * PRISM_TICK_LENGTH,
            anchor.y + axis.y * travelOffset + axis.y * PRISM_TICK_LENGTH,
            anchor.z + axis.z * travelOffset + axis.z * PRISM_TICK_LENGTH,
            COLOR_AXIS,
          );
          if (joint.limits.enabled) {
            const radial = perpendicularOf(axis);
            for (const limitOffset of [joint.limits.min, joint.limits.max]) {
              const cx = anchor.x + axis.x * limitOffset, cy = anchor.y + axis.y * limitOffset, cz = anchor.z + axis.z * limitOffset;
              segment(cx - radial.x * RADIAL_LENGTH, cy - radial.y * RADIAL_LENGTH, cz - radial.z * RADIAL_LENGTH,
                cx + radial.x * RADIAL_LENGTH, cy + radial.y * RADIAL_LENGTH, cz + radial.z * RADIAL_LENGTH,
                limitColor);
            }
          }
        }
      }
      geometry.setDrawRange(0, vertex);
      geometry.getAttribute("position").needsUpdate = true;
      geometry.getAttribute("color").needsUpdate = true;
      geometry.computeBoundingSphere();
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      object.removeFromParent();
    },
  };
}

/** 与轴正交的参考方向：轴接近竖直时取世界 X，否则取世界 Y。 */
export function perpendicularOf(axis: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const candidate = Math.abs(axis.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  // reference × axis（归一化）得到与两者都正交的方向。
  const x = candidate.y * axis.z - candidate.z * axis.y;
  const y = candidate.z * axis.x - candidate.x * axis.z;
  const z = candidate.x * axis.y - candidate.y * axis.x;
  const length = Math.hypot(x, y, z) || 1;
  return { x: x / length, y: y / length, z: z / length };
}

/** 参考方向绕轴旋转 angle（rad）后的径向方向（Rodrigues 公式）。 */
export function rotatedRadial(reference: { x: number; y: number; z: number },
  axis: { x: number; y: number; z: number }, angle: number): { x: number; y: number; z: number } {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const dot = reference.x * axis.x + reference.y * axis.y + reference.z * axis.z;
  const crossX = axis.y * reference.z - axis.z * reference.y;
  const crossY = axis.z * reference.x - axis.x * reference.z;
  const crossZ = axis.x * reference.y - axis.y * reference.x;
  return {
    x: reference.x * cos + crossX * sin + axis.x * dot * (1 - cos),
    y: reference.y * cos + crossY * sin + axis.y * dot * (1 - cos),
    z: reference.z * cos + crossZ * sin + axis.z * dot * (1 - cos),
  };
}
