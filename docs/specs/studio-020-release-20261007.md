# 0.2.0 发布工作记录

面向需要本地编辑、在线浏览与离线交付的 Studio 用户。README 保持原样。

## 现状核查

- 已有（不重建）：pnpm 包、Rust/Tauri/Android 壳、SDK 离线 consumer 门、专用只读 viewer、发布冻结字节与 SHA、GitHub release、Pages 视频工作流、两套视频制作脚本。
- 合同层仍使用已有场景/发布/SDK 协议；产品版本不改变协议版本、工业格式版本或 Unity bridge 0.6.1 的独立版本。
- 已读 package.json、Cargo.toml/Cargo.lock、Tauri/Android manifest，检索实际打包消费方、发布门和历史 0.1.0 产物。远端当前只有 v0.1.0 和 asset-library-v1，没有 v0.2.0。
- 真实缺口：Studio 自有顶层包和客户端元数据仍为 0.1.0；现有镜像只有数据库/对象存储；Pages 只有旧介绍视频；新功能还没有进入两个介绍视频。当前切 Deep 卡死/抖动反馈优先修。

## 交付与验证

### WASM 构建现状核查

生产 32 位目标编译在既有 geometry_dag 的 64 GiB 上限比较处失败：整数常量被推断为 usize，在 wasm32 上编译期溢出。已有 DGC 序列化/黄金字节、Rust/TS 消费方和 flate2 固定依赖不重建，文件格式与上限不改；只用 u64 做上限比较。检索全部依赖/消费者、DGC tests 与 cluster 规格后也确认 WASM 来源指纹遗漏已接入的 geometry_dag path 依赖，将其源码与 Cargo 输入纳入现有指纹并复验失效测试。

随后真实生产编译指出已有 Native 镜像宿主漏掉 deep2d_dynamic_gpu/deep2d_frame_context/deep2d_backdrop_gpu 三个被现有 renderer 引用的模块。检索 main.rs、WASM/Android lib.rs 和实际引用/test 确认 Native 实现与依赖已有，补两个镜像宿主的 #[path] 声明；不新增 Web Deep2D 产品入口。Android 同机制缺失提前一起补，生产构建继续验证。

1. 修指定场景的切换/抖动，收尾第二优先级的当前源码验证。
2. 更新自有发布元数据为 0.2.0，构建 Windows 客户端、Native 查看器、SDK 和 Docker 产物，记录来源与校验和。
3. 更新 docs、两个介绍视频和 Pages 分析/入口。完整编辑器依赖 API，静态浏览能力按真实部署验证记录。
4. 检查当前源码、构建和离线启动，再提交和 push；发布 v0.2.0 附代码包、客户端、SDK、Docker、视频和更新说明。

当前为执行记录，构建中的产物和未通过的门不计为完成。发布资产清单、SHA-256、实际安装/运行覆盖将在完成后回填。

### 在线编辑与新增视频素材

完整Web已支持仓库子路径、独立API origin、分服务登录令牌、资产管理路径和WS地址。94项合同/消费者回归通过；独立三服务在本地完成GLB上传转换/原字节读回、保存重读/发布、流程、本体与鉴权WS，测试容器已清理。公网API配置和完整浏览器验收安排在Deep收尾之后；三个基础几何的只读浏览ZIP不作为完整编辑器交付。部署命令与证据见[完整编辑器托管](../guides/full-editor-hosting.md)。

本体行动预览补齐桌面入口，使用实际对象身份与用户参数；独立QA经正式评审发布v2后，SMT-01预览显示低风险、无需审批及Sensor/Alarm/WorkOrder影响。Agent任务预算保留90秒默认值，可选3/5分钟；真实5分钟预算任务在96.488秒完成3次决策/2次工具，18条匹配返回1行聚合。两项上下文修复保留原始调用/结果与历史，不增加全局扫描预算。验收见[行动预览](studio-ontology-action-preview-20261007.md)、[上下文连续性](studio-agent-context-continuity-20261007.md)。

新版系统片和功能片按同一SMT因果故事制作；真实流程、本体拖线、只读行动预览、Agent结果和Three产线已取得，WASM空图实录不准入。最终两片及字幕/章节/校验和仍待完整镜头与成片验收，当前预览不是Release终稿。进度和源身份见[SMT录制工单](../assets/studio-020/intro-astra-smt-capture.md)。

### 默认引擎与客户端范围（用户 10-07 更新）

本轮取消 Android 构建与交付。Windows Studio、只读 Viewer、Native、SDK、Docker 保留。默认引擎现状核查：全仓引用与未跟踪项、RendererBackend 合同、既有 Three/Deep 依赖、appState 初值消费、rendererCapabilities tests 和 Z1 历史规格均已检查。已有选择优先级 URL > 显式持久偏好；真实缺口是零配置仍依据 navigator.gpu 自动进入 Deep，而当前冷启动尚未过响应验收。0.2 零配置默认 Three/WebGL，保留用户显式 WebGPU/WASM 选择；Deep 的卡顿继续修，不用默认切换代替修复。

### Windows 包取消 Android 运行资源核查

全仓查本地 publication manifest、桌面 prepare/verify、Rust local_api 和 Dashboard startup；其资源映射/Android可选合同已有。无需新依赖，Rust按资源map逐一验证；Dashboard APK 本来是可选能力，缺失时不宣称可用。真实缺口：旧 Windows sidecar 强制拷 APK、JRE、签名工具并且 packageVersion硬编码0.1，违背本轮取消Android与体积目标。添加prepare的可选includeAndroid（通用入口仍兼容旧用途），Windows 0.2明确禁用；JAVA_HOME仅在没有Android资源时可省略，Native映射和验证不放宽，实际安装包随后验收。

Windows Native 接线核查：static exporter 已输出显式 x86_64-pc-windows-msvc target；旧 local API 默认路径仍指向 dynamic target/release。现有 nativeExecutable 参数、manifest/hash/PE 守卫均可复用，无新增依赖；只在桌面准备脚本显式传 static target，避免打入旧0.1构建。
