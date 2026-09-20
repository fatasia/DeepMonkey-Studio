# R10 物理选型验证:Rapier 同源内核跨端确定性(2026-09-20 r1)

依据 `docs/specs/de26-full-gap-analysis-2026-09-19.md` 6.3 节(Rapier/Avian 路线)。
本目录是**独立验证 crate**,不接入主 crate `deep-engine-native` 的构建;选型通过后再决定晋升。

## 结论(一句话)

Rapier 0.35.3(Rust native)与 `@dimforge/rapier3d-compat@0.20.0`(wasm)在**同一场景 spec、
fixed timestep(1/60)× 240 步**下,241 帧变换序列**逐位一致**(f32 位序哈希相等),
wasm 端内双跑逐位一致,native 端内三跑逐位一致。选型的核心风险(跨端确定性)实测消除。

- native poseBitsSha256 = wasm poseBitsSha256 =
  `5b932a57c8ce48c9e9854f22e97ad7c21c09a674c779c63f3691c11be6630309`
- frameSequenceSha256(native = wasm)=
  `841cb2f279d3dfdc30c16eb71f1e930dd54794667da8cb2ff363ec0a67f04ae4`

## 同源内核配对证据(为何"跨端对照"成立)

1. crates.io `cargo add rapier3d` 锁定 `=0.35.3`,Cargo.lock 解析出 **parry3d 0.30.2**。
2. `npm pack @dimforge/rapier3d-compat@0.20.0` 解包,内嵌 base64 wasm 解码后(2,021,200 字节,
   `\0asm` 头)strings 检索到 **83 处 `parry3d-0.30.2`** panic 路径符号。
3. 两侧 parry 三角化版本一致 ⇒ 同一物理内核源码树;差异只在编译目标(x86-64 native vs wasm32)。
4. rust `rapier3d::VERSION` 与 npm 包版本无直接映射表,以上符号检索是本仓库可复现的配对核对方式。

## 复现步骤

```bash
# 1) Rust 侧:测试(native 双跑逐位一致、初速发散、金标等 9 项)
cd packages/deep-engine-native/physics-validate
cargo test

# 2) Rust 侧:产 native 证据
./target/debug/physics-validate.exe scene-spec-v1.json \
  ../../../test-output/r10-rapier-validation-20260920-r1

# 3) wasm 侧:装依赖(独立 npm 项目,不进 pnpm workspace)
cd node-wasm && npm install --no-audit --no-fund

# 4) wasm 侧:跑同场景 + 跨端对照 + 写 evidence.json
node run-and-compare.mjs --spec ../scene-spec-v1.json \
  --native ../../../test-output/r10-rapier-validation-20260920-r1/native-result.json \
  --native-frames ../../../test-output/r10-rapier-validation-20260920-r1/frames-native.jsonl \
  --out ../../../test-output/r10-rapier-validation-20260920-r1 \
  --tests-json ../../../test-output/r10-rapier-validation-20260920-r1/tests-summary.json
```

## 场景与合同要点

- **场景 spec 单一来源**:`scene-spec-v1.json`(3 球不同半径/高度/初速 + 地面盒,
  恢复系数 0.5 弹跳、摩擦 0.05 滚动,休眠禁用)。两端各自读同一文件,不允许手抄参数。
- **固定步长纪律**:dt 以 f64 存 JSON,两端显式转 f32(`as f32` / `Math.fround`,
  IEEE 最近偶舍入),位型 `0x3c888889` 两侧一致;由宿主精确调 `step()` 240 次,
  不用引擎 Variable 步进。无 sleep/线程/随机/真实时间进步进。
- **physics-frame-v1 合同**(复用 dynamic-frame-v1 纪律,源头
  `src/runtime_package/dynamic_scene.rs`):body 按 id 字典序、分量定点 6 位
  (Rust `{:.6}` / TS `toFixed(6)`)、精确 ±0 归一、`-0` 守卫;每帧一行。
- **双哈希**:规范帧串 SHA-256(接 R3 合同形态)+ f32 小端位序 SHA-256(严格逐位门禁,
  不经十进制格式化)。两端**各自独立**从自己的世界状态产出规范串再哈希,杜绝"一侧抄另一侧"。
- **已知格式语义**:极小负数(如 -1e-9)定点格式化为 `-0.000000`,这是 dynamic-frame-v1
  同款语义;Rust/TS 对该形态输出逐字节一致,已在本证据的 241 帧串中实测核验。

## 文件清单

| 文件 | 作用 |
|---|---|
| `Cargo.toml` | 独立 crate;`rapier3d =0.35.3` + `enhanced-determinism`;serde 锁定与主 crate 同版 |
| `scene-spec-v1.json` | 场景/步长/合同参数单一来源 |
| `src/hash.rs` | SHA-256(与主 crate `shader_package/hash.rs` 同实现,含标准向量测试) |
| `src/contract.rs` | physics-frame-v1 规范串、双哈希摘要、首分歧定位器 |
| `src/runner.rs` | Rapier 世界构建 + 固定步长步进 + 逐帧记录 |
| `src/main.rs` | CLI:写 `native-result.json`(含 framesRaw 原始 f32)与 `frames-native.jsonl` |
| `tests/determinism.rs` | 9 项测试(见 evidence.json tests 轴) |
| `node-wasm/` | 独立 npm 项目;`run-and-compare.mjs` 跑 wasm 场景、跨端比对、写 evidence.json |

## 证据目录

`test-output/r10-rapier-validation-20260920-r1/`:`evidence.json`(主证据)、
`tests-summary.json`、`native-result.json`、`frames-native.jsonl`(241 行)、
`wasm-result.json`、`frames-wasm.jsonl`(241 行)、`physics-validate.exe`(本机复现用)。

## F04/F05 双端关节验证

`scene-spec-f04-revolute.json` 覆盖单个 ground→pendulum revolute，
`scene-spec-f05-chain.json` 覆盖三个 revolute 组成的链。两端显式设置 8 次 solver
iterations，并把 joint id/kind/body/anchor/local frame 纳入 `physics-frame-v1` 与
`jointBitsSha256`。2026-09-20 本地证据：F04/F05 均 `bitwiseIdentical=true`，
WASM 重跑稳定，native `cargo test` 7/7。

## F06 马达与双向限位

`scene-spec-f06-motor-limits.json` 使用三个独立 revolute：两个 acceleration-based
position motor 分别向 ±1 rad 驱动，由 ±0.35 rad 限位截停；另一个 force-based
servo 收敛到 0.2 rad。native 与 WASM 共 241 帧逐位一致，WASM 双跑一致。
两端分别移除 motor / limits 后轨迹摘要均改变；native 额外断言最终角度误差 <0.002 rad，
无马达保持静止、无限位两侧角度超过 ±0.9 rad。

- poseBitsSha256：`bbbe5f3b1863188641cf4ed9440163760dd9767539a3feae0dc90d326bbdee28`
- frameSequenceSha256：`c1856b172625a5beb3900e577a86d02842261a3d1b744b859f12a015a44aa21e`
- 证据：仓库根目录 `test-output/r10-f06-motor-limits-20260920-r1/evidence.json`。

关节新增可选 `limits: [min, max]` 和 `motor`，后者显式声明
`targetPosition / targetVelocity / stiffness / damping / model`，model 为 `acceleration` 或 `force`。
数值必须能表示为有限 f32，限位有序，刚度与阻尼非负。控制配置由 spec SHA-256 绑定；
`physics-frame-v1` 不变，F04/F05 的 pose 与 canonical 金标均保持原值。
当前未配置最大马达力，不代表负载/扭矩预算验证；马达速度模式、运行时配置变化、
MultibodyJoint 与产品宿主仍未验收。

在本目录运行 `cargo test --test joint_controls` 和
`cargo run -- scene-spec-f06-motor-limits.json ../../../test-output/r10-f06-motor-limits-20260920-r1`；
随后在仓库根目录运行：

```bash
node packages/deep-engine-native/physics-validate/node-wasm/run-and-compare.mjs \
  --spec packages/deep-engine-native/physics-validate/scene-spec-f06-motor-limits.json \
  --native test-output/r10-f06-motor-limits-20260920-r1/native-result.json \
  --native-frames test-output/r10-f06-motor-limits-20260920-r1/frames-native.jsonl \
  --out test-output/r10-f06-motor-limits-20260920-r1
```

## F07 Multibody 三段摆链

`scene-spec-f07-multibody.json` 用 `solver: "multibody"` 选择 Rapier 的 reduced-coordinate
MultibodyJointSet；不写 solver 时仍为旧 ImpulseJoint。三个水平起始的 revolute 链接在重力下摆动，
native/WASM 共 241 帧的 body pose、joint anchor/frame 和 canonical 摘要全部逐位一致。
WASM 高层类没有 anchor/frame getter，因此读取公开 raw set 的真实值，并释放临时 WASM 对象；
native 逐帧从实际 multibody link 读取，不从场景 spec 合成状态。

- poseBitsSha256：`241e9e4b8208caa4a005769ac4085bd707a2d6a0e2751877949087468317aa20`
- frameSequenceSha256：`98fcbe38daa1ac1d56ca3aad2e7d9f12057181a55407dfeddfd8a1ad731a7113`
- 证据：`test-output/r10-f07-multibody-20260920-r1/evidence.json`，移除关节/关闭重力的两端负对照均改变轨迹。

Native 测试逐帧检查所有锚点相距 <0.00001 场景单位；循环和重复父节点必须失败，
F04–F06 pose/canonical 金标不变。当前 WASM API 不支持 multibody motor/limits setter，
此组合两端明确拒绝，未覆盖动态增删关节、混合求解器或产品宿主。

复现：在本目录运行 `cargo test --test multibody --test joint_controls`，随后按 F06 命令将
spec 改为 `scene-spec-f07-multibody.json`，证据目录改为 `r10-f07-multibody-20260920-r1`。

## 后续接线缺口

- F04(PhysicsWorld 宿主接线):以本 runner 为内核骨架,宿主 tick 固定步长驱动,
  变更集(新增/移除刚体)走 revision 化命令,复用 R3 状态合同的 revision 语义。
- F05/F06/F07 已完成固定 revolute/ImpulseJoint、position motor/双向限位与 Multibody 三段摆链双端门禁；动态控制/拓扑及产品编辑器接线仍待。
- Web 接线:`@dimforge/rapier3d-compat` 免打包加载,与现有 delivery 管线的 wasm 加载方式合并;
  WASM 二进制随包分发(离线纪律),不走 CDN。
- 晋升决策:若采纳,把 `rapier3d =0.35.3` 提升进主 crate `Cargo.toml`(Cargo.lock 变更
  需与 R4 车道协调),本 crate 保留为确定性门禁测试源。
