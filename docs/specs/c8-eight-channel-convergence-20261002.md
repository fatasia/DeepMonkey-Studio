# C8 8 超门通道收敛归因(2026-10-02)

Owner:[c8-full-chain-closure-audit-20261001.md](c8-full-chain-closure-audit-20261001.md);前件:[c8-source-observer-fix-20261002.md](c8-source-observer-fix-20261002.md)(观察器 v4,translated 96/96 captured)。本线消费 v4 产出完成 8 超门通道的 CPU 逐值归因 + GPU 定向验证。原门不变:Three r185 默认参考、曝光、HDR `.002` / byte `2`;未降门、未挑点、未放宽、未改生产、未 commit/push/reset/clean/stash、未跑 cargo、四项用户资产未触。

**质量门结论不变:仍红(8 通道全部判定为固有跨后端实现差,不可在 shader 语义层收敛;LD 草案交 root 裁定,本线未自行豁免)。**

## 1. 现状核查与本线产出位置

- 已有(不重建):run6 完整两 fresh(`test-output/c8-input-chain-20261001/source-gpu-output/rounds.json`)、canonical near+far 基准(`c8-current-canonical-20261001/`,只读,SHA 校验不变)、production F32 输入收据(`c8-f32-inputs-20261001`)、Three 侧对拍收据(`c8-three-f32-inputs-20261001`、`c8-front-normal-20261001`)、CPU 否证集(`c8-input-chain-20261001/conclusion.json`:double normalMatrix / 一次 VP / modelView clip / D·spec 乘序)。
- 本线全部产出在新目录 `test-output/c8-eight-channel-convergence-20261002/`:`progress-01-consumed.json` → `progress-02-attribution.json` → `progress-03-gpu-far-observation.json` → `progress-04-fresh-closure.json`,及本文第 6 节所列脚本与数据件。除本报告外未改任何既有文件。

## 2. 新增观测(任务 1,progress-01)

1. **translated HLSL 全文落盘**:4 个唯一 MeshStandardMaterial fragment 程序(6f3b8297/084c9dd2/c70a77e5/1dbe5fe8)+ 1 个共享 vertex 的 ANGLE HLSL 与原 GLSL 全文(`three-translated/`),来自 run6 观察器捕获(96/96 captured(NB))。Deep 侧语义源 = 冻结 WGSL(`c8-input-chain-20261001/source-full.wgsl`,run6 实际模块的 F32-witness 基座)。
2. **6-slot 观察映射**:witness.a = 模型行匹配 slot;每帧 6 slot 全观测(front: {0:46704,1:2834,2:2664,3:3027,4:2500,5:3711});近斜三个焦点像素 (62,40)/(76,45)/(76,46) 全部 slot 0(fixture-0:球,rough .15,metal 0)。
3. **8 通道逐帧观察值**:近斜 stored 差 [1,1,1]/[2,1,2] half-ULP@[4,8);远斜 (198,64) R/G = −10/−5 half-ULP(−0.00244140625 绝对),且 5×5 阶梯显示 x∈[197,199]、y∈[62,66] 的**空间连贯负差异子区**(非孤立翻转点)。
4. **存储律(本线核心新证)**:canonical near MRT 同 pass prestore F32 vs stored16 共 **496,824 样本,100.000% 命中向零取整(RTZ)**,nearest-even 仅 ~54%。D3D 输出合并器 fp32→fp16 为 RTZ;远端 Three raw F32 → stored16 同律复验(0.2660711705684662 → 1089·2⁻¹²)。

## 3. CPU 逐值归因模型(任务 2,progress-02)

### 3.1 近斜 6 通道:fp32 算术差 × GGX D 尖峰 × RTZ 存储

- 量化表((76,45)/(76,46),prestore 为 canonical 实测、three raw 为 run6 实测):F32 差 1.02/0.97/0.92 与 1.31/1.25/**0.18** ULP;prestore 距 RTZ 格点 0.14/0.26/0.61 与 0.25/0.89/**0.17** step。(76,46) B 是纯 RTZ 翻转样本:F32 两侧仅差 0.18 ULP,因 deep 距格点 0.17、three 距自身格点 0.99,存储差放大为 1 ULP。
- 灵敏度(fp32 中心差分,输入为 GPU 实测 production dots):dSpecFVD/dnh = 2925(76,45)/ 5765(76,46) 每单位 nh;denom = 2.015e-3 / 1.609e-3。复现观测 F32 差(1.0–1.3 ULP)所需 NH 输入差 ≈ 4–6 fp32 ULP(2.4–3.3e-7),与跨后端实测 NH 差 aggregate max 2.384e-7(4 ULP,brdf-primitive-analysis)同量级;像素 (76,46) 精确差:NL 2 ULP、alpha² 1.16e-9、VH 0(owner 审计 line-337 收据)。
- **插值器排除**:D3D11 插值器 fp32 双侧同轨;CPU 透视正确插值复现 GPU NH:(76,45) **逐位相同**(0.9996453523635864),(76,46)/(62,40) 差 ≤2 fp32 ULP(conclusion.json focus)。→ 点积 1e-7 级差来自 VS/normalize 编译调度,不是插值硬件。
- **导数排除(近端)**:deepGeometryRoughness 恒等式在 GPU 收据上精确(roughIdentityExact=true,rough−clamp(.15)=max(max(dx,dy)));Three r185 同型公式(view 空间 nonPerturbedNormal 的 max(abs(dFdx),abs(dFdy)))。
- 等输入对照:Deep 语义 vs Three r185 语义(非融合 fp32)CPU 全式对照差 ≤9e-8 相对 → **公式/常量/表逐位同源**,全部差异来自输入。

### 3.2 远斜 2 通道:后端导数 lane 差 → geometryRoughness → D

- 传导链:ddx helper-lane 关联差(S8:deep dx z=0.0886「上行」/ three 0.0808「下行」,CPU 平面外推误差 <2.2e-4;explicit-derivative 探针证明该关联非 API 固定)→ roughness 差(deep 高)→ α=a² 差 → denom≈a2 区 dD/da2<0 → deep 单次散射更低 → 存储连贯 −10/−5 half-ULP。
- raycast 标定:近斜 (76,45) 以 y-down 屏幕约定 raycast 复现 GPU dots(vh 逐位一致,nv/nl ≤0.5% 子像素误差);等 roughness 对照差 ≤9e-8(公式同源再次成立);roughness 对=±0.0078125 → 预测相对差 −1.8%(raycast dots)/owner 审计 S6-dots 链独立预测 .0025733 vs 实测 .0025635(0.4%)。

## 4. GPU 定向验证(任务 4,progress-03/04)

**run:far 尺度(cameraScale 1)production 精确 F32 观测**,7 捕获(6 输入模式 + full prestore witness)× 2 fresh,逐字节一致,零争用重试;28 项保存守卫(deepStored16/deepDisplay/threeRawF32/threeDisplay)对 canonical far/raw **全零**。机制:本目录 `runner-far.mjs` + `c8FarF32Probe.ts`,esbuild/playwright 复用既有 frozen lab;失败重试一次后定位到 frozen scratch 的硬编码生产哈希过期(未提交的 C12 白炉修复改动 pbrShader 3 行),改为运行时哈希克隆 `c8FarF32InputsShader` 并保留 sourceIdentity + 位零保存双保险(C12 在本 fixture 不活跃:environment:false → frame.eye.w=0;位零保存即行为证明)。

fresh 收获:

| 量 | 值 | 意义 |
|---|---|---|
| 远斜 deep prestore F32 | [0.263517826795578, 0.7846123576164246, 0.18510523438453674] | **首次实测**;trunc16 → 1079·2⁻¹² = 0.263427734375 = 实际 stored16,RTZ 律在远端直证 |
| deep roughness fresh | 0.988566517829895 | rough−0.9 = 0.088566518 = max(dx,dy) 精确;与 S8 历史 0.088562012 差 5e-5(S8 生产映射复现) |
| fresh dots | nv .51994 / nl .97968 / nh .82047 / vh .91388 | raycast 校验基准(nv 差 0.0027) |

**无标度闭环**(fresh-far-v3.mjs):fixture emissive 在 direct-diagnostic 仍生效(setStage 只换 color;emission[2]=[0.1,0.65,0.15]),扣 emission 后三通道单次散射相对差 = **−1.56/−1.60/−1.75%**(近等值,符合通道无关输入差预期;CPU 预测 −1.43%);跨通道比值消去 emission/multi/光标度后解得 **roughThree = 0.98232 → three geometryRough = 0.08232**,与 S8 独立实测 three ddx z = 0.080811 差 **1.9%** —— 远斜「导数 lane → roughness → D」归因以 fresh 生产收据定量闭环。

## 5. 逐通道判定与 LD 草案(任务 3)

### 5.1 判定

| 通道 | 判定 | 机制 |
|---|---|---|
| 近斜 (76,45) R/G/B | **固有量化边界** | 后端 fp32 算术调度差(点积 ≤4–6 ULP)× D 尖峰(denom 2.015e-3)× RTZ 存储 → 1 half-ULP |
| 近斜 (76,46) R/B/G | **固有量化边界** | 同链(denom 1.609e-3,增益 5765);存储 [2,1,2] 含一个纯 RTZ 翻转(B:F32 差仅 0.18 ULP) |
| 远斜 (198,64) R/G | **固有(后端导数实现差)** | ddx helper-lane 关联差 → geometryRoughness 差(fresh 0.088566518 vs three ≈0.0808–0.0823)→ D → 连贯区 −10/−5 half-ULP |

「固有」的可证伪判据(均已实测):等输入对照差 ≤9e-8(公式同源);输入差幅度 ≤6 fp32 ULP 且与该像素灵敏度乘积覆盖观测输出差;输入差归零则存储差归零。收敛前提是两条管线逐位一致 —— 不同 API 栈(WebGL/ANGLE/D3D11 vs WebGPU/Dawn/D3D12)下不成立。

### 5.2 修复候选评估(均未改生产)

- **候选 A**(显式 bottom dx/left dy 对齐 Three lane):该线已 GPU 实测 improved 6225 / worse 6125 / 同 35611、零修复 —— 非收敛修复,不重提。
- **候选 B**(builtin 精度路径):GPU 实测 no-op,该线已闭。
- **cross-form D 分母**(Filament 式 cross 消去 1−nh²):CPU 分析否决 —— 参考侧冻结保留易消去形式,噪声对称,不会使两侧靠拢。
- **结论:无 shader 级修复候选**;修复面 = 后端导数/四边形行为,超出 shader 语义层,交 root。

### 5.3 LD 草案(格式对齐 `registerLegalDifference`;status=diagnostic;**是否登记由 root 裁定,本线不自行注册/豁免**)

```js
// LD-16(草案,交 root)
{ id: "LD-16", layer: ["hdr-color"],
  difference: "直射 GGX 主瓣区双后端 fp32 算术调度差(点积 ≤4-6 ULP)× D 尖峰(denom≈1.6-2.0e-3, dSpec/dnh≈2.9e5-5.8e5)× D3D RTZ 存储: 亮度 4.1-6.6 区 1-2 half-ulp(0.0039-0.0078) 超 .002 门",
  host: { web: "Three r185 via WebGL/ANGLE(D3D11)", native: "生产 PBR plain via WebGPU/Dawn(D3D12)" },
  rule: "同时满足: (1)数值源同源-等输入 CPU 全式对照差 ≤1e-7 相对; (2)阶梯形态-存储差=±k·ulp(亮度) 且两侧 prestore F32 距 RTZ 格点 <1 step(F32 差 ≤1.5 ULP); (3)输入差 ≤6 fp32 ULP 且其×该像素 D 灵敏度覆盖观测输出差; (4)全域符号混合。局部 3×3 单符号不作必要条件(D 尖峰邻域增益符号一致所致);系统性 >1.5 ULP F32 同号差不得援引(远斜归 LD-17)",
  evidence: ["docs/specs/c8-eight-channel-convergence-20261002.md", "test-output/c8-eight-channel-convergence-20261002/progress-02-attribution.json", "test-output/c8-eight-channel-convergence-20261002/consumed-mrt.json", "test-output/c8-input-chain-20261001/conclusion.json"],
  status: "diagnostic" }
// LD-17(草案,交 root)
{ id: "LD-17", layer: ["hdr-color"],
  difference: "后端 ddx helper-lane 关联差 × geometryRoughness(远斜实测 deep 0.088566518 vs three 0.0808-0.0823)→ 粗糙金属区持续同号存储差 ≤10 half-ulp@0.26",
  host: { web: "Three r185 lights_physical_fragment geometryRoughness(非扰动法线 dFdx/dFdy)", native: "生产 deepViewGeometryRoughness(视图域法线 dpdx/dpdy)" },
  rule: "同时满足: (1)该像素 roughness 双侧实测差 ≥2/256 且等输入对照差 ≤1e-7 相对; (2)双侧 ddx/dy 分别匹配 CPU 平面外推的相邻行/列(误差 <2.2e-4); (3)差的空间形态为粗糙金属主瓣连贯区(非孤立翻转); (4)跨通道比值消去后解得的 roughness 与独立 ddx 实测一致(本轮 1.9%)。shader 语义层不可修(候选 A 已 GPU 否)",
  evidence: ["docs/specs/c8-eight-channel-convergence-20261002.md", "test-output/c8-eight-channel-convergence-20261002/progress-04-fresh-closure.json", "test-output/c8-eight-channel-convergence-20261002/gpu-far-output/evidence.json", "docs/specs/c8-full-chain-closure-audit-20261001.md"],
  status: "diagnostic" }
```

与 LD-15 的关系:LD-15 的「邻域符号混合」必要条件在最坏局部 3×3 不成立(owner 审计已确认),LD-16 草案将该条件改述为全域混合 + D 尖峰邻域符号一致解释,并加 RTZ 格点邻近判据(本线新证据);是否修订 LD-15 或登记 LD-16/17 均由 root 裁定。

## 6. 证据清单(全部在本目录,另有注明除外)

- 里程碑:`progress-01-consumed.json`、`progress-02-attribution.json`、`progress-03-gpu-far-observation.json`(runner 落盘)、`progress-04-fresh-closure.json`
- 提取:`extract-run6.mjs`/`consumed-run6.json`、`extract-canonical.mjs`/`consumed-canonical.json`、`extract-mrt.mjs`/`consumed-mrt.json`(截断律 496,824 样本)、`make-progress-01.mjs`
- 归因:`attribute.mjs`/`attribution-model.json`、`calibrate.mjs`、`fresh-far-v3.mjs`/`fresh-far-closure.json`
- GPU:`runner-far.mjs`、`c8FarF32Probe.ts`、`c8FarInputsShader.ts`、`gpu-far-output/{evidence.json,rounds.json,probe.mjs,runner-far.log}`
- translated:`three-translated/`(4 fragment + 1 vertex,GLSL+HLSL)
- 上游消费(只读):`c8-input-chain-20261001/{salvage-analysis.json,conclusion.json,source-full.wgsl,source-gpu-output/rounds.json}`、`c8-current-canonical-20261001/{gpu-output, mrt-output}`(基准 SHA d92af27f… 不变)、`c8-f32-inputs-20261001/input-analysis.json`、`c8-front-normal-20261001/brdf-primitive-analysis.json`、owner 审计 `c8-full-chain-closure-audit-20261001.md`

## 7. 诚实条款与遗留

- 远斜无标度拟合的残差:roughTSolvedGB=0.98504(B 通道差太小,比值噪声大);lightScaleK 三通道 3.64/3.46/3.28(±10%,模型三阶残差:multi 逐通道恒等的假设、f0/base 精确值、f90=1);multiTermImplied(−0.0151)与审计值(+0.0193)符号不符,该约束弱,不用于结论。
- 近斜 NH 3.3e-7 的像素级 gap 为「由输出反推」(Three 侧 h 未直接观测);aggregate NH max 2.384e-7 为直接观测,量级一致。
- C8 行剩余:(a) root 对 LD-16/LD-17(或 LD-15 修订)的登记裁定;(b) 裁定通过前的质量门维持 RED,正式双端方案不提升;(c) `jc-i-continuation` 未改,由 root 统一回填。
