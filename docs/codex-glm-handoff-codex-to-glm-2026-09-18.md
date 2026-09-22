# Codex -> GLM 主线交接（2026-09-18）

## 承接规则

1. 先读本文件，再读引用的权威 spec；不得把测试绿当作产品验收。
2. 只做列出的收口任务；不开新半成品、不重复建设、不放宽预算换通过。
3. 每个任务完成必须留下：产物、日志/截图/哈希、结论和剩余边界。
4. 工业格式禁止商业 SDK、云转换、源 CAD 软件作为运行依赖或验收。
5. Parasolid 用户可见名只用 X_T；扩展名 .x_t。

## 当前完成面

- Deep2D：表格排序、翻页、CSV/Excel 导出、取消与保存保护已实现；合同/运行时定向测试 40 项通过。R8b 已到栅格后构包，但被 132 资源预算拒绝：146 resources / 73 nodes。之前 2 行 fixture 的 R6 压缩证明可到 117 resources / 61 nodes。
- Engine：静态几何/材质/纹理/相机、多灯、点/聚光投影阴影、HDR 环境预滤、品牌 ZIP/EXE 已有证据；GI 单次反弹已解决大色块并具备 Web 重烘和 Native 消费证据。
- 工业：JT Windows Job/取消/崩溃/资源治理通过；RVT 42 个真实开洞构件已验证；SolidWorks 5 个真实零件解码；E57 姿态/属性链路通过；X_T 109/109 witness match；3DM Float32 塌缩清零；3D Tiles 离线解析 5 个 b3dm。

## 可直接执行任务队列

### A. Deep2D 收口

1. 读取 `test-output/dashboard-table-production-r8b-20260918` 失败记录和 R6 压缩 proof。
2. 只压缩表格重复图元/重复 atlas，不提高 132 资源、128 节点、64 MiB 预算，不删功能。
3. 重建 deployment bundle 后重跑 4 行 linked-table 正式链；成功后跑真实排序/CSV/Excel/取消窗口验收。
4. 更新表格 spec 与 recovery ledger；只有两轮窗口证据后才标完成。

### B. Engine 收口

1. Fog：复用 Web 天气到 HDR fog 合同，Native 补版本化 exp2、真实相机裁剪和背景深度规则；不改天气语义。
2. GI：做同资产/同机位/同曝光/同照明的跨端阈值矩阵，覆盖复杂几何、多 UV 岛、材质/遮挡组合。
3. 动态场景：接通剖切、轨迹动画、dataBindings、interactions，复用现有 Native 内核。
4. 发布/安装：浏览器下载落盘、取消/刷新中断、OS 禁网、干净安装/升级/卸载和用户数据保留。
5. D24-D28 项目级后验收另行闭环，不用单 feature 证据替代。

### C. 工业 S0-S6 收口

1. S0：补 E57 构建负例、许可闭包、断网安装体积/冷启动预算。
2. S1：先解决 Postgres CAS 与多实例租约，再扩展解析器受限令牌与重试/缓存矩阵。
3. S2：JT 补版本/LOD/外部引用；3DM 处理双侧共边、非共形边和产品接线。
4. S3：补点云完整合同、CRS/姿态、分块回收和 Native point primitive；Tiles 补严格预检、GLB1 转换、运行时消费。
5. S4/S5：X_T 处理重建曲面/交线和单位/闭合性；RVT 扩到结构/机电/链接；SolidWorks 必须拿到多来源装配证据。
6. S6：七方向做独立版本保留集、混合场景 Native/Web 发布、断网安装和升级/回滚。

### D. DE26 后置链

1. V1-V7 做扎实，V8 小而强，V9/V10/V11/V13 按真实场景补齐，V12 不做。
2. V11 预置道路、地面、围栏、绿化模板；优先复用 C07 素材库，缺素材用开放来源并记录授权/哈希。
3. 光照、材质、阴影、多灯、GI 对齐 Unity 视觉目标；Three/Babylon 对照工程实现，Unity/UE 对照系统设计与视觉目标。
4. WebGPU 客户端与网页端一致性按同作者场景、同资产、同机位、同照明/曝光做阈值验收。

## 证据入口

- `docs/specs/deep2d-table-interaction-2026-09-18.md`
- `docs/specs/deep-engine-mainline-remaining-audit-2026-09-18.md`
- `docs/specs/industrial-stage-delta-2026-09-18.md`
- `docs/specs/lightmap-single-bounce-2026-09-18.md`
- `docs/specs/scene-native-baked-gi-consumption-2026-09-18.md`
- `test-output/dashboard-table-resources-r6-20260918.json.compaction-proof.json`

## 当前状态

Deep2D、Engine、工业线都不能宣称“全部完成”。本文件是唯一可继续推进的收口队列；完成后必须回填对应 spec，不得只留口头结论。
