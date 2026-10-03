# F5 radiance → irradiance 方向消费 — 2026-10-02（先行核查）

> 原61项内F5续刀。上一刀真实moments内部子集已落，F5整项原sealed退化/32RMSE失败仍开放。当前GPU归root J3，本刀先CPU数学/负控；UI/cargo/帧时为0，不改root账本与其他线路。

## 现状核查（六步，已有不重建）

1. 全仓grep含未跟踪：`probeRadianceKernel`的球面32方向均值、texture/storage采样、PBR IBL与`diffuseIrradiance`、bake/feedback都有；moments改动在自有叶，root四红/B1材质不碰。
2. 合同层：公共`IrradianceProbeRecord`仅RGB/validity/meanDistance/variance/miss/relocation，96B含reserved0..2但**保留≠SH合同**；32方向不能改。Frame`deepDiffuse`64B已有L0/L1作者环境/半球辐照系数，但不是空间probe的directional data。
3. 依赖：已用Three0.185.1含`SphericalHarmonics3`9×RGB投影/余弦卷积与LightProbeGenerator，不能说从零无SH。库可作独立oracle，不引新依赖。deep-engine纯runtime暂无空间probe SH字段/消费，不能凭Three类存在宣称接通。
4. 消费：environmentShader.diffuse是cosine importance卷积的 **E(n)/π**（明确注释）；`shade`diffuse直接乘base，无额外/π。authored diffuse是E(n)并/π。capture当前是首次命中Lambert Lo=ρE_hit/π 或miss ambient，然后 **(1/N)ΣLi**，单位是球面平均radiance，不是n相关E/π。normal权重是probe位置方向权重，不是入射射线卷积，不能补回方向。
5. 测试/证据：现constant白炉、diffuseIrradiance、32dir/MC、multibounce与feedback、bake均在；旧MC隔离同球面功能量，不能证明surface shading方向/单位正确。上刀完整142/141正控能量诊断/同包delta读数都保留。
6. 规格：L4/L5/moments/旧F5-T02-G3报告与root只读已核；最小物理修必须独立解析证明，不改旧门/挑点/削IBL或材质。

## 可证伪能量链与数学目标

- radiance `Li(ω)`单位W/(m²·sr)；irradiance `E(n)=∫sphere Li(ω) max(n·ω,0)dω`单位W/m²；Lambert outgoing `Lo=ρ E/π`。
- 当前PBR的`diffuseEnvironment(n)`应表示`J(n)=E(n)/π`。常量Li=C时J=C，原球面平均也C，是**白炉会掩盖**的特殊情况。
- 对均匀球面样本，正确接收J估计为`(4/N)ΣLi(ω_i) max(n·ω_i,0)`，4来自1/(πp),p=1/(4π)，不是盲乘π/2；当前avg没有normal，任意全局scale也不能恢复n相关项。
- 半球遮挡相同球面mean=C/2，但朝光J=C、背光J=0、侧向J=C/2；相同RGB不可区分，方向信息丢失是可证明机制缺口。
- 环境ambient读取自**已卷积diffuse cube**均值，不是raw sky directional Li；注入miss常量会丢sky方向及cubeface立体角，不能据此叫与显示基线相同。

## 先行oracle/负控矩阵（≥6，跑后追加）

独立解析/本地官方源码：常量天空、单入射有限角锥（north cap）、半球遮挡、旋转协变、黑source与黑receiver albedo、白炉/有效域环境相同基线、RGB通道隔离/线性曝光、场景方向丢失反例。32方向原样参与误差展示，不扩方向以追门；高采样中点球面积分与Three SH卷积仅独立oracle，不换原F5分母。

官方参考：PBRT4 Lambertian `R/π`；Three r185 SphericalHarmonics3.getIrradianceAt（cosine卷积bandsπ,2π/3,π/4）/LightProbeGenerator（solid-angle与4π权重）；NVIDIA RTXGI DDGI官方directional irradiance texel与query direction实现。下载定版本/SHA只存test-output，不导入生产、尊重许可。

## 实施门与边界

先跑数学负控，若平均已丢方向则不能在RGB处乘常数修复。新的方向编码不得偷偷占96Breserved作为公共SH。若有必要优先复用既有SH数学或directional texture内部可选通道方案，先精确报告预算/生命周期/公共记录影响给root，确认后动手；当前零生产修改。

本刀不触rootstaging/layered/capability/B1 material，旧sealed负比值和32RMSE原证并列。Native旧storage对RGB/π行为与Web E/π不同，需显式列为未认证而不暗中同步。物理质量未过不宣称完成或95%。
