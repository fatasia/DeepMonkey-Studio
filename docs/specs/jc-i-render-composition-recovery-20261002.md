# J/C/I 渲染组合四个真实失败收口（2026-10-02）

## 现状核查

1. 全仓/未跟踪：F5验收准确指出 pbrEnvironmentIntensity、pbrUnitNormalContract（分层+变形组合导入）、packetDeformationUnsupported、hlodProxyDrawBatch 四失败当前真实存在；不按“在途”忽略。认领分层组合适配、staging fail-fast、强度测试和capability观察，不改F5 pbrShader生产GI叶。
2. 契约：PBR Vertex已支持普通/normal mapped/deformation；分层引入metalTangent；PbrRendererFeatures已有layeredMaterials=false；共享manifest与selfcheck对拍需读实际清单，不抬GPU limits或另建能力表。
3. 依赖：Vitest/Three/naga/WebGPU/esbuild已有，禁cargo，新叶≤300行。
4. 消费：composeLayeredMaterialSceneShader接普通/变形完整shader；stagePacketBuffers共用入场验证；rendererCapabilitySelfCheck模块导入即阻断HLOD；测试过期inline串不能当运行时物理错误。
5. 证据：F5 final规格四失败精确定位；已有plain layered6、deformation3均绿但组合失败，组合不得以单族绿豁免。shader Naga现有DEEP_SHADER_NAGA_BIN入口复用。
6. 规格：原61行JC/I优先、F5错误四族移交、I23分层已做不重建；root账本仅主线程写，保护全部用户/并行修改，不commit/push/reset/clean/stash。

**已有（不重建）**：分层主核、变形读流、shader组合、feature开关、强度helper和caps漂移门。

**真实缺口**：全模块replaceOnce匹配两处同型vertex语句；deformed没有正确metalTangent初始化；staging先访问undefinedcontext再做deformation拒绝；selfcheck新增feature未登记；强度测试还锁旧inlineLod表达式。

## 最小方案

- 用函数限定的字节替换，仅改目标vertex函数，不在全shaderreplaceAll绕fail-closed；为deepPoseVertex单独消费pose.tangent与法线生成metalTangent，覆盖普通/变形/textureArray/分层组合，真实Naga验证。
- deformation fail-fast移到任何设备/texture/vertex入场前；验证fixture无副作用而非换mock遮盖。
- 复用已有capability id观察layeredMaterials默认，若manifest真无对应capability而需公共扩面另记录，不凭selfcheck杜撰支持。
- 强度测试锁实际helper调用与缩放位置、环境irradiance与direct/emissive不变性，不能删掉强度验证。
- capability无需新增id/公共类型：现有`material-clearcoat`行覆盖扩展层材质，补webFeatureKeys的`layeredMaterials`与selfcheck默认false观察，同步原golden字段；native原支持档/原因不改，本批只做Node三方文本对拍，禁cargo。原基础扩展材质与新层块范围仍不同，不扩大native支持宣称。
- 组合核查发现arrays+layered在生产`createPipelinesBuild`明确fail-closed拒绝；不要求未支持profile通过、不为测试擅自新增渲染能力。新增门只验static-layered/deformation-layered，arrays同族保持原profile，不混合。
- 修前四红记录与修后同族矩阵必须可查；GPU窗口暂归F5，本切片先CPU/Naga。

## 结果

- 修前四文件原证 `before-four.json`：2实际case失败+2导入suite失败（failed不能用numFailedTests掩盖suite）。
- 修复分层vertex适配按函数边界replaceOnce，普通/normalMapped各独立锚；deepPoseVertex从pose.tangent经instance transform消费metalTangent，避免引用普通rawTangent或零默认varying。保双重组合/锚缺失fail-closed，plain不变。
- staging入场deformation拒绝先于streaming/context访问与资源准备；原两case负控green。
- intensity锁真实 `deepPbrReflectionRadiance(...)*frame.lightDirection.w`（kept-mip rebase和局部反射helper原生产路径），保两个IBL缩放与diffuseGI/direct/emissive锚，不改shader物理公式。
- selfcheck与manifest/golden现有`material-clearcoat`行同步登记layeredMaterials=false，未增capabilityId/结构/支持词汇、未改native旧档；Node文本三方对拍22/22，native编译未做（禁cargo）。
- **聚焦68/68、0skip**，包含真实Naga完整plain-layered与deformation-layered解析语义验证；manifest **22/22**。
- 广域首次 **2943/2944** 的F5新b16尾项装配由该owner修复后，主线程实际再跑 **2948/2948、0skip、0fail**（完整Naga启用），证据 `final-full-family.json`。历史四失败全部核销，不忽略在途；这仍是登记源码批次，不等于全部GPU认证。
- engine src/lab/examples、contracts、web共5类型配置均exit0；`git diff --check`本批无错（CRLF规范化warning如实）。
- 物理F6源码之后仅注释/证据变更不沿旧sourceIdentity自动叫currentfresh；其GPU旧receipt对应登记批，修复数学不变。

### 边界

arrays+layered为产品明确拒绝profile，不虚构支持；分层+变形完整GPUdraw双fresh本批未跑，Naga≠渲染正确性，仍需GPU窗口。在广域唯一在途失败实际绿并复跑前，不宣全仓绿；本批只清实际四故障不闭C8原HDR门、不扩大I23已验范围。
