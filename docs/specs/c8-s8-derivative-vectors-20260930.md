# C8-S8 正式normal与默认导数向量

读取两端几何粗糙度实际使用的view-normal、abs(dx)、abs(dy)，核对S7棋盘相位的成因。保留GL/default WGSL算子及产品语义。

## 现状核查

1. 全仓packages/apps、lab/scripts与未跟踪文件：S6/S7正式编译拦截/读回已有；J3真实view-normal附件为rgba8、另一fixture及他路锁域，不能作为本场景导数输入。无当前fixture默认导数向量观察能力。
2. 契约：GPU注入、RenderView/packet与capture都有现成定义；本刀仅扩lab，未新增产品ABI。
3. 依赖：现有Three r185、Vitest/esbuild/Chrome足够，无新库、renderer或IR。
4. 消费：canonical deepGeometryRoughness(normal)真实计算abs(dpdx/dpdy)后max；Three physical chunk对nonPerturbedNormal真实计算abs(dFdx/dFdy)后max。两端已有正常化view-space几何normal，不使用贴图扰动normal。
5. 测试/证据：S7两fresh/4realm通过，Fine没有修复最差(198,64)，x偶/y奇1087像素中1086 rough与Three相同。S6/S7已提交2f63640e/63b1d591，有原source/仪表化source/实际GL编译收据，不重复平台。
6. 文档：读取S4–S7、恢复台账；生产pbrShader/environment冻结，J3/I占GPU。C8仅拥有隔离lab/helpers；先CPU，GPU由根排序。

**已有（不重建）**：同作者root、正式两端材质/灯链、FP16读回与源码身份。**真实缺口**：只有NV/NL/rough scalar，无法确认实际导数输入与差分行列；S7相位解释仍为推断。

## 预注册范围与因果判据

冻结far scale1、front控制/oblique、原Three r185、曝光.5、actual RGBA16F 320×192，两fresh。三观察模式：view-normal以.5*n+.5编码，dx/dy输出正式abs向量。仅在canonical和Three原dxy计算处保存中间量，保留原max与其消费；不在另一个函数重算导数。摄像机、材质、灯、packet与模式source身份门沿用。仅dark1920×1080两截图。

源码捕获的默认dFdx/dFdy与dpdx/dpdy保持；未知mode、混入Fine/Coarse、源漂移、没有实际编译命中、非有限/空附件、变packet和无完整三模式矩阵拒绝。normal有效范围/单位长度（解码后长度误差≤.003）和非均匀法线检查，稳定共同内部像素≥1000。

normal与有限差分核对容差预注册为.0025：FP16 .5*n+.5解码再做两点差分，量化误差上界约.001953125，再保留导数half量化与f32差额。该数值只解释观察精度，不放宽S5 HDR .002/display2门。

对完整共同2×2像素块，CPU只索引实际normal输出，求两行横差/两列纵差；分别检查实际abs(dx)/abs(dy)是否对应这些正常差分。输出每backend的匹配率、候选行列分布及不可解释像素，不任意平移min搜索洗掉残差。若两端normal的p99差≤.0025，且每backend两轴在≥95%的完整共同quad匹配上述正常差分，则只登记合法backend导数评估位置差异；否则继续标成未解释，不改生产。内部三角形helper/extrapolation可造成剩余不匹配，按实际比例记录。

本刀qualityCertified=false，原S5最终质量门独立。如果相位由正常差分行列解释，结束该单像素支线，转完整材质链生产统一缺口；不做高阶导数或手工quad补偿，不换LUT/曝光。

## 实测结果

12个Vitest聚焦装配/恢复测试、12个Node负例/因果分类测试、lab类型和runner语法检查通过。`node scripts/c8-derivative-vectors.mjs` 两fresh轮、六独立realm实际通过且附件逐值稳定，GPU已释放。证据在 `test-output/interrupted-0930/c8-derivative-vectors/`：evidence.json、rounds.json、两dark1080截图、analysis.json/analyze.mjs。每run实际Deep module命中一次，Three四个唯一实际编译源/十二次源码读取；产品源保持。

| 实际视角 | 共同稳定内部 | normal最大差 / p99 | abs(dx)最大差 / p99 | abs(dy)最大差 / p99 |
|---|---:|---:|---:|---:|
| far front控制 | 5027 | 0 / 0 | .0093994140625 / .003910064697265625 | .000030517578125 / .00000005960464477539063 |
| far oblique | 4328 | .0009765625 / 0 | .013763427734375 / .0045928955078125 | .00030517578125 / .00000011920928955078125 |

实际法线基准一致，dy近乎一致，残差集中dx。但完整quad有限差分匹配率只有80.5%–85.5%，低于预注册95%，两视角classification均为`unexplained derivative residue`。保持.0025解释容差，不能把相位推断升级成已证实合法差异。完整共同quad数量front1169、oblique990。

保存既存最差点仅为索引复核：两端实际normal完全相同，dy完全相同；dx.z为Three .080810546875 / Deep .08856201171875，与S6 rough残差同方向。两端实际导数均不等于相邻观察normal简单差值；primitive/helper归属未观测。按根指令结束逐像素支线，残差留档，转生产材质家族消费缺口。

正式Deep原module SHA仍 `6cc13053306df85a4a4a17bf0ed7bb689b6d6adba1d6eab0e80f33ce135b7b7b`，pbrShader/environmentShader精确SHA同S6/S7。当前bundle SHA `b5799cf32c5196e07208e737df34ba52119287132518faef854ace2827621e1a`。证据记录当前所有观察源，不声明其他生产文件全局冻结。S5 HDR绝对.002/display2门保持；qualityCertified=false。

## 视觉范围与同族检查

两张实际dark1920×1080截图已核看，六组法线/dx/dy和两端完整、无裁切/遮挡。导数数值很小，因此未经显示放大的诊断图较暗；数值附件和编译收据才是主要证据。对标原Three r185正式材质链，最终Studio画质未认证。

十维范围评分：布局9、令牌9、排版9、交互状态不适用、动效不适用、最终3D画质未认证（实际片元诊断）、信息设计9、即时反馈不适用、主题/尺寸9（用户仅dark1080）、术语9。同族覆盖两视角/三观察/两fresh，实际normal单位长度、非空derivative信号、source/packet/默认算子、Three三chunk finally恢复均通过；未扩旧矩阵或重复白炉。
