# C8-S7 导数因果验证

读取实际有效roughness和单散射响应，判断S6残差是否来自默认导数的实现选择；产品数学、LUT、曝光与质量门保持。

## 现状核查

1. 全仓packages/apps源码、lab/scripts与未跟踪文件核查：无fine/coarse生产或诊断切换。已有S6正式片元装配与真实GPU收据，不重建renderer、投影或读回平台。
2. 契约：GPU注入、正式RenderView/packet已有；切换只留lab，不新增产品状态或宿主ABI。
3. 依赖：现有Three r185、Chrome/esbuild/Vitest已在用，无新依赖。
4. 消费：canonical brdfDirectLighting.wgsl的deepGeometryRoughness使用dpdx/dpdy，生产PBR与directDisplay真实消费；Three lights_physical_fragment使用dFdx/dFdy(nonPerturbedNormal)。两端已有view-space normal与effective roughness。
5. 测试/证据：S6两fresh轮稳定，far-oblique最差点rough .98046875/.98828125、single红差 .0025634765625；原S5最终红差 .0029296875。S6已提交2f63640e，保持默认入口。
6. 文档：读取S4/S5/S6与恢复台账；根锁生产源，GPU由J3/I串行。本刀仅隔离叶子候选。

**已有（不重建）**：同root正式双端、源漂移守卫、实际编译收据、FP16附件、两轮视觉证据。**真实缺口**：未确认WGSL默认导数选择与GLSL默认导数是否一致，粗糙度残差原因尚需实际片元因果验证。

## 官方语义与范围

WGSL的dpdx/dpdy允许选择对应Fine或Coarse；导数仅片元、需uniform控制流。[W3C WGSL §17.6](https://www.w3.org/TR/WGSL/#derivative-builtin-functions)。GLSL ES300只公开dFdx/dFdy，允许实现近似及精度提示；没有桌面GLSL的Fine/Coarse内建。[Khronos GLSL ES300 §8.9](https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf)。WebGL公开扩展注册表没有derivative-control。[Khronos WebGL扩展](https://registry.khronos.org/webgl/extensions/)。因此Three原default保持，Deep隔离candidate显式Fine/Coarse；不升级宿主语言，不把GL hint冒充精确fine/coarse。

冻结far scale1、front控制/oblique、曝光.5、原Three r185、实际RGBA16F、320×192。读取packed(rough,实际single.r,实际single.g)，不复制BRDF数学；两candidate×两fresh共四独立realm，按用户仅dark1920×1080截图。原S6全RGB/近远观测保留。

候选只替换canonical helper中dpdx/dpdy精确源码行，标明实际Deep原/改SHA及Three保持default收据。零命中、未知candidate、漂移源码、非有限/空帧、相机/packet复用、无真实single贡献拒绝。数值作为因果诊断，qualityCertified=false；不修改原HDR .002/display2门。实际结果决定后继最窄生产修改，当前不改生产。

## 实测与结论

CPU：9个Vitest聚焦装配/资源测试、10个Node身份/负例测试通过，lab类型与runner语法检查通过。原S6默认geometry/single生成字符串和入口保持，新增只在显式rough-single/fine/coarse启用。

`node scripts/c8-derivative-ablation.mjs` 两fresh轮、四独立realm通过且附件逐值稳定。证据 `test-output/interrupted-0930/c8-derivative-ablation/` 中evidence.json、rounds.json、两dark1920×1080截图、analysis.json/analyze.mjs。每run实际Deep正式module命中一次、Three四个唯一真实编译源/十二次读取；qualityCertified=false。GPU已经释放，产品未改。

| 显式Deep候选 / 原Three default | 稳定内部 | rough最大差 / p99 | single RG最大差 / p99 |
|---|---:|---:|---:|
| fine front控制 | 5027 | .00732421875 / .0025634765625 | .00146484375 / .000244140625 |
| fine oblique | 4328 | .01123046875 / .0029296875 | .0029296875 / .0003662109375 |
| coarse front控制 | 5027 | .00732421875 / .002685546875 | .00146484375 / .000244140625 |
| coarse oblique | 4328 | .01220703125 / .00341796875 | .0025634765625 / .0003662109375 |

Coarse复现S6 default数值。Fine减少部分rough残差，但single最差更大，不能据此修改生产。S5 far-oblique最差(198,64)在default/fine/coarse三个实际候选逐half一致：Three packed [.98046875,.146728515625,.12396240234375]，Deep [.98828125,.1441650390625,.12176513671875]。换Fine没有修复该点。

源身份一致：实际原Deep module SHA `6cc13053306df85a4a4a17bf0ed7bb689b6d6adba1d6eab0e80f33ce135b7b7b`，与S6相同，比较不是跨旧算法拼接。pbrShader/environmentShader精确SHA仍同S6；证据保存当前bundle及全部观察源身份，不声明其他生产源全局冻结。

CPU只索引已读回附件的奇偶分组：Fine的x偶/y奇组1087个稳定内部像素中1086个rough逐half等于Three，p99=0/max .00048828125；另三组最大差 .007568359375–.01123046875，Coarse四组均有残差。**推断**：2×2相位特征指向GL/WGPU窗口坐标原点与默认导数取样行列，尚需实际view-normal/导数向量或独立相位控制才能证明，不能写成已证实根因。单纯Fine/Coarse不构成质量修复。

## 视觉范围与同族检查

两张实际dark1080截图已查看，四组front/oblique控制和候选完整，无遮挡/裁切；观察RGB含义明确，原single高光真实可见。对标原Three r185材质链。十维范围评分：布局9、令牌9、排版9、交互状态不适用、动效不适用、最终3D画质未认证（仅片元诊断）、信息设计9、即时反馈不适用、主题/尺寸9（用户仅dark1080）、术语9。没有产品UI变更，完整Studio场景未测试。

同族检查覆盖两相机、两候选、两fresh轮与四像素相位组。错误backend/空实际module/缺GL编译、变packet/变原Three/非有限附件等均有失败门。保留S5 HDR绝对.002/display2门、原LUT/曝光；不重复白炉或旧J5矩阵。
