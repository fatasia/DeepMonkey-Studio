# C8-S9 正式多灯直射材质消费

让额外方向灯、点光和聚光消费已有canonical直接多散射核，复用正式PBR的单个DFG资源。

## 现状核查

1. 全仓packages/apps、lab/scripts及未跟踪文件已查：S5主光已接直接补能；clusterLightingPbrWgsl的deepClusterBrdf仍仅单散射。S8七文件独立冻结，不重复导数平台。
2. 契约：DirectionalLight/PointLight/SpotLight、WorldClusteredLights和RenderView已经存在；pbrSceneLighting把首方向灯留主光、slice(1)交cluster，显式directional:[]代表关闭主光。group0现有DFG/sampler，group3现有灯ABI，无新资源/字段。
3. 依赖：Three r185、Vitest、esbuild、Chrome均已在用；无新增库/renderer/IR。
4. 消费：正式pbrShader shade、directDisplay两入口调用Forward+ WorldReceivingF0。point/spot/额外directional均走同deepClusterBrdf。公开FORWARD_PLUS_PBR_WGSL同时被独立无DFG GPU probe和CPU合同测试使用，不能直接依赖frame/LUT。当前primary helper按sunColor.w早退，不能复用到local-only。
5. 测试/证据：已有clusterLightingPbr、localLightAttenuation、IES/LTC字节门和正式S4共同root附件读回；S5主光控制、S6–S8导数诊断已完成，不重复旧矩阵。独立灯库默认字节保持。
6. 文档：读S4–S8规格、恢复台账与本轮锁域。S5明确Native/cluster/visibility后继；Native主光由root负责。本刀仅Web正式多灯，production三文件锁批准，GPU由root串行排序。

**已有（不重建）**：灯投影/聚簇/局部阴影/IES、共同作者场景、canonical能量核、单DFG纹理。**真实缺口**：正式本地灯和额外方向灯缺少直接补能；主光为零时原采样helper不适用。

## 冻结方案与预注册

公开texture-free库及默认composer不变；formal profile仅在唯一BRDF return接缝调用宿主补能adapter。canonical能量公式不复制。保留原NDF/Smith/roughness/F0、range/decay/cone/IES/阴影、LTC面积光。visibility resolve无DFG ABI，留后继。

宿主私有viewDFG缓存按fragment invocation独立，并在正式shade/sample入口重置；已有主光/IBL viewDFG可seed复用。local-only第一盏实际NL>0且radiance正贡献的灯才读取viewDFG，此后同材质每个正贡献灯读取lightDFG一次；NL≤0或全零radiance跳过。无新纹理/绑定，初始化LUT预算不变。

真实共同root fixture覆盖point-only、spot-only、secondary-directional，原Three r185、曝光.5、ACES固定，320×192实际RGBA16F、两视角与strict-emissive开关灯控制，两fresh；截图仅dark1920×1080。必须确认point/spot无主光、实际两端贡献≥1000像素、source/packet/完整矩阵、轮廓真实1px与stable interior≥1000。strict-emissive HDR≤.002/display≤2；直射完整品质继续记录HDR≤.002/display≤2的通过状态，未满足保留差异，不调整阈值。仪表化legacy single-scatter仅作补能因果消融，不能代替原Three质量基线。

聚焦负例：未知formal profile、宿主helper缺失/接缝漂移；local-only不得sun gate、零radiance/NL不得采样；原独立library不含DFG依赖/缓存；重复灯/缺失fixture、非有限/空帧、旧source/实际编译未命中拒绝。当前未测性能和完整Studio场景不声明完成。

## 实测交付

三生产文件新增40行左右，公开无DFG库本体保持。formal library只替换唯一return接缝；移除该补能段后逐字恢复原库。主光/IBL样本seed到fragment私有cache；本地路径无sun早退。canonical能量/纹理/绑定/初始化预算未增。

8个聚焦测试文件56通过、2个可选Naga测试未启用；包含原局部衰减/IES/LTC字节合同与共同root测试。14个Node负例/比较器测试、lab tsc、runner语法通过。`node scripts/c8-local-direct-parity.mjs`完成两fresh×六realm、48正式帧；实际生产模块每realm命中一次，Three真实编译program收据非空，两轮所有附件/packet/source逐值稳定，GPU已释放。证据：`test-output/interrupted-0930/c8-local-direct/evidence.json`、rounds.json、两dark1080截图。runner启动删除旧收据，完成前再次核对所有源SHA，失败删除成功证据。

| 灯家族 / 视角 | stable内部 | 原单散射HDR最大差 → 正式补能最大差 | 原单散射display最大差 → 正式 | 补能实际改变像素 |
|---|---:|---:|---:|---:|
| 点光 / front | 5027 | .0157470703125 → .001953125 | 4 → 1 | 3643 |
| 点光 / oblique | 4328 | .0172119140625 → .01171875 | 5 → 1 | 3174 |
| 聚光 / front | 5027 | .0157470703125 → .001953125 | 4 → 1 | 3643 |
| 聚光 / oblique | 4328 | .0172119140625 → .01171875 | 5 → 1 | 3174 |
| 额外方向光 / front | 5027 | .019775390625 → .00146484375 | 5 → 1 | 3738 |
| 额外方向光 / oblique | 4328 | .021728515625 → .0029296875 | 5 → 1 | 3304 |

两端实际关灯→开灯贡献4490–5428像素，primary强度0；实际两端轮廓差0。聚光fixture在完整cone内部，cone/IES/阴影形态保留由原聚焦合同覆盖，本轮未认证cone边缘或阴影视觉。补能max新增point/spot .015380859375、额外directional .0196533203125；实际HDR RMSE相比单散射下降94.1%–98.2%。消融仅移除同模块cluster补能段，原Three和其实际输出逐值不变。

front三家族HDR .002门通过；oblique仍未通过，display均通过2字节门。`passed=true`只认证正式多灯消费/控制/稳定，`qualityCertified=false`明确保留全链HDR缺口；S5/S8未解释导数残差不作新归因，也不调整曝光/精度/阈值。Native由root另路交付，LTC/visibility未扩。

## 视觉闭环与范围评分

两张实际dark1920×1080截图已核看：六组原Three/Deep完整可见，灯光高光宽度、层次和色调接近，标签无遮挡/裁切。使用现有base令牌与同作者fixture，对标原Three r185正式材质响应；Studio氛围/钻取/动效不在此诊断图范围。

十维范围评分：布局9、令牌9、排版9、交互状态不适用、动效不适用、3D材质响应9（HDR全链未认证）、信息设计9、即时反馈不适用、主题/尺寸9（用户仅dark1080）、术语9。保持未认证项；同族覆盖额外方向灯/point/spot与primary0、开关灯/补能消融、两实际视角及两fresh，不重跑旧白炉/导数矩阵。
