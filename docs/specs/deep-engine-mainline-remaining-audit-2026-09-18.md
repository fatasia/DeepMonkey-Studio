# Engine 原主线剩余关口（2026-09-18）

本次只审查计划、当前消费代码和已有证据，未重跑已通过项目。静态 Native 交付已完成的能力保留；不以 DE26 整卡状态计算主线进度。

## 最少五个未闭合关口

| 关口 | 定位与实际缺口 | 状态 |
|---|---|---|
| 作者动态场景与二维/三维共用数据 | 原任务 D11–D19（`deep-engine-next-development-tasks-2026-09-15.md:87`）；`sceneInactiveFields.ts:36/44/68/72` 仍将启用剖切、有轨迹动画、非空 dataBindings/interactions 等标为 deferred；`compileSceneRuntimePackage.ts:20/87` 仍为 static-render-packet。现有 Native 输入/动画内核与 Deep2D HTTP 不等于同一作者 Scene 的正式消费 | 本轮待办；复用现有模块接线，不重造内核 |
| 一般作者环境消费 | D14（任务表 :90）；已验纯色、多灯、点/聚投影及 HDR 反射。`compileSceneEnvironment.ts:10` 仍只接 skybox none/grid false；`compileSceneHdrEnvironment.ts:9` 拒全景背景；`compileSceneLighting.ts:11` 拒 globalIlluminationEnabled true。雾/后处理等作者字段不能默默丢弃 | 本轮待办；本次支持档之外继续阻断 |
| 发布完整产品验收 | D01/D03/D10；`scenePublicationCompatibilityGate.ts:43` 仍拒 confirmation-required，没有确认降级后的消费契约；发布 UI 浏览器下载落盘、执行取消/刷新中断与 OS 禁网全链证据未闭。已有 HTTP 实际导出 ZIP 与停 API 六窗不重做 | 本轮待办；“停 API”不等于“OS 断网” |
| 安装发行 | D22（任务表 :107）要求干净 Windows 安装/升级/卸载、不删用户数据与签名。当前已验品牌 EXE/portable、LKG、无参数离线启动，不等于签名安装发行。未找到可关闭该条的正式证据 | 本轮待办；代码实现与干净机证据分别记录 |
| 原项目级后验收 | D24–D28（任务表 :116–120）：三套 50 万三角/200 实例资产、同资产/视角/曝光跨端视觉阈值、正式场景优化开关和统一 20 分钟稳定/故障门。当前真实资产 paired、Deep2D 像素合同和技术夹具分别覆盖子集 | 项目级后验收；不是新增 DE26 需求，也不能由一个探针通过替代 |

## GI 色块归属

9 月 15 日原 D14 要求保留作者光照语义，没有单列“实现新 GI 算法”。9 月 18 日用户另外明确要求真实 GI/HDR 与 Unity 光照效果，因此单跳烘焙的色块属于当前新增高质量灯光目标未关闭，不能当作已删除 DE26 项；也不应反向抹掉原静态交付链的验收。

真实 GI GLB 已经 Web 烘焙/重载及 Native 导入显示，两轮各自稳定；红色反弹进入后墙和地面。两端测试没有冻结相同机位/曝光/环境，也未设置跨端像素阈值，不能据此宣布 D26 全部通过。见 `lightmap-single-bounce-2026-09-18.md`、`scene-native-baked-gi-consumption-2026-09-18.md`。

## 已验收能力与不再扩展项

已验：静态几何/材质/纹理/相机及局部原点；版本化作者纯色、方向/点/聚灯与投影阴影；HDR 源冻结/预滤/离线 EXE；材质变体真实 GPU 差分和失败旧帧；默认/用户品牌、真实 ZIP 校验。对应 `scene-authored-*-2026-09-18.md` 与 `scene-client-branding-delivery-2026-09-18.md`。这些不是 Web 与 Native 的整场景视觉等价证明。

明确排除或后置：全 Three 插件兼容、复杂 Shader Graph、非 Windows、重型 RT/路径追踪、UE 全套虚拟几何及长尾解码器；RT 不阻塞原 P0–P3；8 小时 WebGPU soak 已取消。DE26 新增强继续后置；已删除 A05–A07/V01–V05、用户 V12 不以别名回流。原 D11–D28 不因映射 DE26 而消失。

## Fog 接线核查：Native 收口已完成（2026-09-18 更新）

作者没有独立 `environment.fog` 字段，实际来自 `SceneSnapshot.weather`。`viewerEngineRig.ts` 为各天气生成 Three `FogExp2`，`studioDeepFog.ts` 将其转为 Web HDR 域 exp2/linear 合同；`contracts/sceneWeatherFog.ts`（V1）为版本化天气雾合同，`compileSceneEnvironment.ts` 产出 `deep-engine.solid-environment` v7 + fog `{schemaVersion:1,kind:"exp2",colorLinearRgb,density}`。

Native 侧本切片已完成（2026-09-18）：
- `runtime_package/solid_environment.rs` 解析 author fog（fail-closed：kind 校验、密度/颜色越界拒绝、非 v7 档声明 fog 一律拒绝），v7 profile 要求 fog 必填；雾色线性域直通。
- `FogSettings::authored_exp2` 进入渲染：`content_profile::for_content` 用作者 fog 替换宿主雾档，`requires_content_rebuild` 判雾差异，`drop_preview` 加雾变更硬守卫（与 lighting 同型）；`requires_output_pass()` 对 exp2 为 false，走 mesh shader 逐像素合成（真实相机深度，`native_mesh_v1.wgsl` z==2.0 分支），背景由 solid background 承担不受雾。
- legacy 输出雾 shader（`native_output_fog_v1/bloom_fog_v1.wgsl`）near/far 改为从 frame 雾投影行动态读取（帧 ABI 1920B 一致），消除 0.1/100 硬编码。
- 测试与证据：CPU exp2 公式与 Three FogExp2 数值对齐（容差 <1e-6）；`cargo test --lib` 401 通过、bin 140、clippy -D warnings 0；真实 GPU：authored exp2 全屏读回 changed=47723/307200 且逐像素方向性收敛、legacy `--smoke-fog` scopes clean、solid 家族（resize/替换/回滚/LKG）回归通过。证据 `test-output/fog-authored-2026-09-18/`。
- 边界：Web 侧 sceneWeatherFog→包的端到端编译产物验证属 Web lane 未做；作者相机(near/far≠默认)+legacy 输出雾组合的专用像素用例未建（动态 near/far 已由 uniform 单测与 mesh shader 共源保证，风险低）。
