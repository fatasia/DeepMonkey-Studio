# C8 LD-16/LD-17 root 裁定(2026-10-02,主线程/root)

> 归因专线(c8-eight-channel-convergence-20261002)交付 LD-16/LD-17 草案并按纪律未自行豁免。本文件=root 裁定:**登记为 diagnostic,不豁免 HDR 门,qualityCertified 维持 false**;最终批准权留用户。

## 裁定

1. **LD-16(直射 GGX 主瓣区调度差×D 尖峰×RTZ)登记为 diagnostic**——采纳草案 rule 全部四判据(数值源同源 ≤1e-7/RTZ 格点邻近 ≤1.5 ULP/输入差×D 灵敏度覆盖/全域符号混合,局部单符号以 D 尖峰邻域增益解释)。
2. **LD-17(后端 ddx helper-lane 差×geometryRoughness)登记为 diagnostic**——采纳草案 rule 四判据(roughness 双侧实测 ≥2/256+平面外推匹配 <2.2e-4+连贯区形态+比值解与独立 ddx 实测一致 1.9%);**shader 语义层不可修**(候选 A GPU 否证、候选 B no-op、cross-form CPU 否决)。
3. **LD-15 修订**:LD-15 的「局部 3×3 邻域符号混合」必要条件被 owner 审计证伪(最坏局部不成立),由 LD-16 的「全域符号混合+D 尖峰邻域符号一致」替代;LD-15 在其原始适用域(point/spot 高光峰 3 half-ulp)保持登记,跨域引用以 LD-16 为准。
4. **效力边界(重申,不可扩大)**:
   - diagnostic 仅作**归因解释**,不构成 HDR 0.002 门的豁免——8 通道超门事实不变,`qualityCertified=false` 维持;
   - 系统性 >1.5 ULP F32 同号差、远斜域、未来任何新增超门通道**不得援引** LD-16/17(各有独立 rule,须逐通道重新满足全部判据);
   - 修复面=D3D 后端导数/四边形行为与 RTZ 存储(shader 语义层无修复候选,已 GPU/CPU 双向否证)——若未来后端行为变化(驱动/Chrome 升级),本两 LD 需重新验证。

## 依据摘要(全链证据见 c8-eight-channel-convergence-20261002 §5)

- RTZ 直证:canonical prestore↔stored 496,824 样本 100% 向零取整(nearest-even 仅 54%);远端 Three raw→stored 复验。
- 插值器排除:CPU 透视插值复现 GPU NH((76,45) 逐位相同,其余 ≤2 ULP)。
- 公式同源:等输入 CPU 全式对照 ≤9e-8;F_Schlick 双侧同式。
- 修复候选否证:候选 A GPU 实测 6225 改善/6125 恶化(零净修复)、B no-op、cross-form 分母 CPU 否决(参考冻结+噪声对称)。
- fresh 闭环:远斜定向 run×2 fresh 逐字节一致、28 项保存守卫全零、roughness fresh 0.988566518=S8 历史复现。

## 遗留与诚实条款

- 归因模型残差如实保留(远斜 B 通道比值噪声/multi 恒等假设弱约束不符/近斜 NH 像素级 gap 为反推值),详见归因报告 §7;这些不推翻结论,但记录模型精度边界。
- C8 行状态:**质量门 RED 维持**,LD-16/17 作为诊断解释登记;**用户最终批准**(或推翻)本裁定前,不提升任何双端方案、不改 qualityCertified。
