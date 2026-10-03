# J3 完整场景合法差异登记

本表补充冻结的 LD-01–15，适用于工业包 `e685bb6e683e943165ad6dd53215e0a3282569892dbbf0b447481e92e8df52d5` 的登记共同域。旧比较器和旧失败保持；证书不接受任意边缘、阴影或材质残差。

## 现状核查

已有层目录、`registerLegalDifference`、逐层原门及 source freshness 守卫，直接复用。已核对源码消费、RenderPacket/RuntimePackage、现有依赖、两端 renderer、原九层48格和完整工业场景附件，以及权威 Gate D 规格。缺口是同包组合证据及独立来源登记，不是新渲染器。完整六步与对象/输入范围见 [独立审查](j3-d-full-independent-closure-review-20261001.md)。

| 登记 | 范围与允许条件 | 实际证据 | 必须拒绝 |
|---|---|---|---|
| LD-16 标准 MSAA 覆盖 | 仅 south-west 像素107328；原完整 catwalk 源三角形、实际VP/8bit subpixel及标准4x位置证明 Native 样本2/3命中、Web中心漏。保存原1px失败，不扩跳过域 | `coverage-audit.json`、实际 Vulkan 设备声明 | 整个catwalk移除、对象身份或源深度不符 |
| LD-17 独立 CSM/raster profile | 各端实际四级联矩阵及 raster bias Web1/1、Native2/2由同一源caster计算；712原点的各端 binary16 HDR区间必须通过。四个跨端区间不相交仍留原结果 | `reprojection-audit.json`、`final-oracle-negatives.json`；Web真实fragment/16texel观察 | wrong caster matrix、整柱移除、bias0；不接受按实测调宽HDR门 |
| LD-18 零直射控制 | 保留原3点，独立winding/NdotL<0、positive base、无环境/发光证明实际HDR0；不以零分母反推visibility | `zero-contract-audit.json`、`all-frames-audit.json` | 相反光向/背面合同变异；移除原控制点 |
| LD-19 比较采样器量化 | 独立16mask×147488query/device、四fresh真实设备证明守恒1/256双线性权重；工业所有16texel comparison bits及九sample整数和与source相同 | sampler masks GPU收据；`observed-operation-audit.json` | 错mask、量化单位变异或漏caster；不从工业UV拟合精度 |
| LD-20 最后 PCF 除法 | 仅精确k/256采样和的最终 `/9`，采用 WGSL f32除法规范2.5ULP逐输入推导区间；实际compute与fragment精确相同。五处 correctly-rounded CPU 点值差仍保留 | `pcfOperationReference.test.mjs` 2305正例/2负控；actual observer | 分母8、改变采样和；不改变.002 HDR、half或byte1门 |
| LD-21 同包不同后处理链 | Web Fog→Bloom 与Native Bloom→Fog按各自原独立profile/reference验收；真实64帧/32组包含中间附件，最终原byte1/SSIM | industrial effects实际收据和root4960源核验 | 漏pass、错误矩阵/附件/输出；不宣称跨算法最终图相等 |

上述 JSON/脚本位于 `test-output/j3-d-fullscene-csm-diagnosis-20261001/`，GPU目录和哈希见其中 `gate-d-closure-review.md` 与 `closure-artifact-hashes.json`。root独立复跑32完整512² HDR→正式共同输出最大1字节、最低SSIM .9999901659；8个无阴影组的1159点（含297曲面）逐值0。observer16帧原七域完整数组SHA保持，2860 diagnostic 的control仅visibility变1，其余75float精确不变。

LD-20的预算直接取 [WGSL concrete floating point accuracy](https://www.w3.org/TR/2026/CRD-WGSL-20260921/#floating-point-accuracy)，不是依据五处误差扩大容差。此设备精度结论不外推任意GPU。

21:00最终：当前登记J3-D-full行关闭，详见[最终独立裁定](j3-d-full-independent-closure-review-20261001.md)。20:17九层48格真实刷新批次已通过；当前core32帧/715点精确join和最终effects12:38:40的64帧原门均通过，4982效果记录源与当前逐SHA匹配。旧广域source guard因后续无关作者/F6源变化失效的记录仍作为measured batch；不改写fresh标志，也不改旧strictfalse。Gate E、OIT/RT及本工业包未启用的高层材质组合继续按各自任务与支持合同管理。
