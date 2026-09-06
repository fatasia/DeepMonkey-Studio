// 本仓库自制诊断机器人；只供隔离门禁，不引用或修改用户工业模型。
export const URDF_GATE_NAME = "关节验证机器人.urdf";
export const URDF_GATE_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<robot name="Studio joint validation arm">
  <material name="housing"><color rgba="0.25 0.38 0.49 1"/></material>
  <material name="arm"><color rgba="0.85 0.65 0.22 1"/></material>
  <material name="tool"><color rgba="0.25 0.65 0.55 1"/></material>
  <link name="base"><visual><origin xyz="0 0 0.12"/><geometry><cylinder radius="0.22" length="0.24"/></geometry><material name="housing"/></visual>
    <collision><origin xyz="0 0 0.12"/><geometry><cylinder radius="0.22" length="0.24"/></geometry></collision>
    <inertial><origin xyz="0 0 0.12"/><mass value="10"/><inertia ixx="0.1" ixy="0" ixz="0" iyy="0.1" iyz="0" izz="0.1"/></inertial></link>
  <link name="shoulder"><visual><geometry><sphere radius="0.13"/></geometry><material name="housing"/></visual></link>
  <joint name="base_yaw" type="continuous"><parent link="base"/><child link="shoulder"/><origin xyz="0 0 0.3"/><axis xyz=" 0 0 1 "/></joint>
  <link name="upper_arm"><visual><origin xyz="0 0 0.3"/><geometry><box size="0.14 0.14 0.6"/></geometry><material name="arm"/></visual></link>
  <joint name="shoulder_pitch" type="revolute"><parent link="shoulder"/><child link="upper_arm"/><axis xyz="0 1 0"/><limit lower="-1.5" upper="1.5" effort="80" velocity="1.5"/></joint>
  <link name="forearm"><visual><origin xyz="0.24 0 0"/><geometry><box size="0.48 0.11 0.11"/></geometry><material name="arm"/></visual></link>
  <joint name="elbow_pitch" type="revolute"><parent link="upper_arm"/><child link="forearm"/><origin xyz="0 0 0.6"/><axis xyz="0 1 0"/><limit lower="-1.7" upper="1.7" effort="40" velocity="2"/></joint>
  <link name="tool_mount"><visual><geometry><box size="0.14 0.18 0.16"/></geometry><material name="housing"/></visual></link>
  <joint name="tool_mount_fixed" type="fixed"><parent link="forearm"/><child link="tool_mount"/><origin xyz="0.5 0 0"/><axis/></joint>
  <link name="left_finger"><visual><origin xyz="0.1 0 0"/><geometry><box size="0.2 0.025 0.05"/></geometry><material name="tool"/></visual></link>
  <joint name="gripper_open" type="prismatic"><parent link="tool_mount"/><child link="left_finger"/><origin xyz="0.06 0.025 0"/><axis xyz="0 1 0"/><limit lower="0" upper="0.06" effort="20" velocity="0.1"/></joint>
  <link name="right_finger"><visual><origin xyz="0.1 0 0"/><geometry><box size="0.2 0.025 0.05"/></geometry><material name="tool"/></visual></link>
  <joint name="gripper_mimic" type="prismatic"><parent link="tool_mount"/><child link="right_finger"/><origin xyz="0.06 -0.025 0"/><axis xyz="0 -1 0"/><limit lower="0" upper="0.06" effort="20" velocity="0.1"/><mimic joint="gripper_open" multiplier="1" offset="0"/></joint>
</robot>`;

export const URDF_GATE_POSE = { base_yaw: 0.35, shoulder_pitch: 0.45, elbow_pitch: -0.55, gripper_open: 0.04 };
