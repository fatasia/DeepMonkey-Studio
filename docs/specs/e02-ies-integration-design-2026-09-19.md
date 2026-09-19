# E02 · IES 光域网集成设计（2026-09-19）

状态：设计完成、待实现（实现切片归 E02/E05，主线程已备好解析器）。依据：五轴定档（`de26-high-value-scope-analysis-2026-09-19.md` 第 10 节，深入光照轴"IES 进验收分母"）。本设计只挂现有卡，不新建灯光权威。

## 1. 审计现状（2026-09-19 实读代码）

- 运行包局部灯载体：`packages/deep-engine/src/runtimePackage/localLights.ts`，字段 `kind/position/direction/radiance/range/decay/innerCos/outerCos(/castShadow)`，验证为严格白名单。
- Native 消费：`packages/deep-engine-native/src/runtime_package/solid_environment.rs` → 灯数据进渲染管线；`r3_state.rs` 已确立状态合同的量化纪律。
- 解析器已就绪：`packages/deep-engine/src/lighting/iesProfile.ts`（LM-63 解析 + 区域法光通量 + 解析解验证 5 测绿；TILT 文件合同性拒绝）。
- 缺口：灯无角度强度分布语义；radiance 是全向常数。

## 2. 集成合同（增量、向后兼容）

```text
LocalLight 增加可选字段:
  ies?: { profileId: string; rotationDeg?: number; scaleFactor?: number }
运行包新增资源节:
  lightProfiles: Array<{ profileId, format:"LM-63-1995"|"LM-63-2002",
    verticalAngles: number[]（0.5° 网格化，升序）,
    candela: number[][]（1e-3 量化）,
    horizontalSymmetry: 1|2|4,   // 复用解析器的对称系数语义
    totalLumens: number }>
```

- 验证：`ies` 存在而 `lightProfiles` 缺对应 profileId → 构建失败（列名）；profileId 重复 → 失败。不支持的字段（TILT、B/A 型光度）沿用解析器的合同性拒绝，**不静默降级为全向灯**。
- 缩放纪律：`scaleFactor` 限 0..10；乘后亮度仍受现有 radiance 上限约束。

## 3. 运行时消费（Web 与 Native 同语义）

1. 采样函数（唯一权威实现，TS 与 Rust 各一份、golden 互钉，同 `r3_state` 纪律）：
   `intensityFactor(θ, φ) = table(θ,φ) / maxCandela`，θ/φ 用 0.5° 网格最近邻（先近邻、后双线性，两档分开验收）。
2. Web：spot/point 着色器增加 IES 采样路径（着色体系归 R2 车道管；实现排在 R2 IR 收口后，避免两套着色源）。
3. Native：candela 表进 uniform/texture，`section_uniform` 同级注入；wgpu 侧与 Web 采样同一量化表 → 跨端数值一致。
4. 无 `ies` 字段的灯行为完全不变（回归保证）。

## 4. 跨端确定性

- 量化先行：角度 0.5° 网格、坎德拉 1e-3、`-0→+0`，f32 ULP 论证同 `r3-state-frame-v1`（复用其合同格式追加 `ies=` 字段于帧摘要）。
- 验收：同一冻结灯阵（含 3 个不同 IES profile + 1 个无 IES 灯）在 WebGL/WebGPU/Native 的帧摘要逐字节一致；采样函数对解析解锥形（1000cd 半球）的积分误差 < 1%。

## 5. 验收清单（进入 E02/E05 分母）

| 格 | 判据 |
|---|---|
| 解析 | LM-63 样本解析→量化表→摘要（流明/峰值/光束角）与解析器输出一致 |
| 构建 | 缺 profileId/重复/TILT 拒绝，错误列名可定位 |
| 渲染 | 锥形 profile 照地光斑边界与 10% 光束角一致（截图闭环 + 逐像素阈值） |
| 跨端 | 三端帧摘要逐字节一致（含旋转 45°、scaleFactor 0.5 用例） |
| 回归 | 无 IES 字段的既有场景证据不回退（asset-material-flow 重跑） |

真实样本：解析器测试现用合成夹具；入库真实 IES 样本按工业样本纪律（来源/SHA-256/授权）从公开光域网库补齐，任务在实现切片内完成。
