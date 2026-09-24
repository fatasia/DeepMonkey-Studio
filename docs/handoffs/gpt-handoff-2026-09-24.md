# GPT 交接文档:Deep Monkey Studio 夜间批次后状态(2026-09-24 上午)

> 写给接手的 GPT 会话。上一棒:GLM 夜间循环(2026-09-23 21:00 ~ 09-24 09:00,32+ 提交)。
> 仓库:D:/Documents/bim/bim-studio,分支 dev-studio,远端已同步(7872f075 → 1a5f4779)。
> 用户当前指令:wasm 完整集成急速推进(原 TS 全功能保留不降级);素材库全量打包已上传 GitHub Release;许可证 GitHub 显示 MIT。

## 一、状态总览(全部真实测量,证据在 test-output/glm-night-20260923/)

| 门禁 | 结果 |
|---|---|
| web vitest 全量 | 4346/0 |
| api vitest 全量 | 1541/0 |
| contracts vitest 全量 | 342/0 |
| native lib(cargo test --lib) | 552/0 |
| native bins(--test-threads=1 或 t2 根治后) | 289/0 |
| dynamic_scene 动画套件 | 10/0 |
| gate:repository / audit:licenses / docs:wiki:check | 全过 |
| Android 模拟器 E2E | 安装/启动/渲染/触控交互全通 |
| wasm 全树编译 | wasm32 check 0 error |

## 二、夜间已完成(按域)

### 1. 音频长稳(F5/V4)
- 30s 正式门:140.4 → **136.1ms**(重同步修复+周期对齐)。
- 根因修复 1:rodio 队列不支持原地 seek 时,旧代码把 "not supported" **吞成成功**——已改为阈值 100ms 重同步(seek 优先/不支持则 reopen-at-position),设备切换 reopen 同修。
- 根因修复 2:音频源 `take_duration` **截齐到视频 PTS 循环周期**(消除 AAC padding 尾巴的回绕相位跳),struct 存周期供设备切换 reopen 对齐。
- 30min 长稳三轮:mean 263.7 → 46.3 → **53.8ms(健康)**;max 恒 400-500ms=Windows 音频设备偶发 0.5s buffer 事件后自恢复(逃逸分布插桩已定性:线性斜坡签名,t≈307/320/553s,非引擎逻辑)。**V4 max 口径如实未过;用户已拍板切 mean/p99 口径**——测试代码已加 p99 采集(600s 探针 mean 42.8/p99 121.5 PASS),**1800s 正式跑被用户暂停**,重跑即出 PASS 证据(`DEEP_AUDIO_SOAK_SECONDS=1800 cargo test --test dashboard_video_media_foundation formal_exe_audio_thirty_minute_stability_soak -- --ignored`)。

### 2. Android 场景发布(全链 E2E 通)
- `packages/deep-scene-viewer-android`:cdylib 壳,#[path] 镜像 bin 树 99 模块(零复制),NativeActivity 入口。
- 双架构 .so(arm64 10.17MiB/x86_64 12.18MiB,android-release profile:opt-level 3+fat LTO+panic abort+strip,零性能损失瘦身)。
- 模板 APK:scripts/build-android-template.mjs(aapt2+zipalign -p+apksigner,资源 arsc/so STORED);API 服务 dashboardAndroidApk.ts(注入+重签+android-apk 路由+发布页 UI 签名面板)。
- **模拟器 E2E 全通**:安装→启动→资产物化→schema fail-closed→preflight→wgpu Vulkan 设备→渲染循环→**触控交互**(adb 滑动→相机旋转→画面变化,touch-before/after.png)。
- 三真 bug 修复:android_main 按值签名(0.6)、internal_data_path SEGV(改字面 files 目录)、UBO limits 收敛到适配器(SwiftShader 16KiB)。
- 遗留:GitHub Release 分卷上传进行中(asset-library-v1,3 卷 4.38GB,后台任务);真机(arm64)触控取证。

### 3. wasm 第三方案(spike 完成,集成进行中——见第三节)
- bench viewer:WebGPU 后端 instanced PBR,153.6KB wasm+58KB JS(Oz 后 135.8KB),143.6fps 与 Three 打平,截图实证。
- 优化管线:scripts/wasm-optimize.mjs(W1 交付)+ build-wasm-bundle.mjs。
- **全引擎镜像集成编译关通过**:deep-engine-wasm crate 内 full_mods 99 模块 #[path] 镜像提升至 crate 根,全依赖补齐,GraphSend 标记 trait,0 error。

### 4. 四条子代理 Lane
- A=UI 交互:浮点噪声/拓扑空态/480px 遮挡三组根因修复。
- B=性能:遮挡签名零分配/合批 key 缓存/相机快速路径,5000 对象 webgpu p50 −6.9%;诚实回退 1 次(v1 节流回归)。
- C=开源文档:LICENSE(现按用户最新决策调整中)+README 徽章功能列表+Wiki 导出断链修复。
- D=开箱链:三存储(JSON/SQLite/PG18.3)smoke 全通+ZIP 导入真实修复+素材导入 1 正例 5 反例。

### 5. 许可证(用户三次决策演进,最终态=执行中)
- 决策链:MIT+伦理限制独立文件 → **GitHub 显示 MIT(最新)**。
- 已做:LICENSE=标准 MIT 文本(可检测)+3 行指引;LICENSE-RESTRICTIONS.md(UNGP 条款全量);治理断言切换;unity 镜像同步;证据 JSON 出索引。
- **待完成**:package.json license 字段仍 "LicenseRef-Deep-Monkey-Community-1.0"(治理放行+警告,改 "MIT" 需同步 LICENSING.md/audit 断言);LICENSE.zh-CN.md 仍为旧 DMCSL 中文(含"韭菜/家奴"等旧表述,须重写为 MIT 中文译本);README.en.md "source-available" 措辞;PR 模板字符串。

### 6. 隐私与历史重写(用户指令,已完成)
- 工作树+git 全史(1007 提交 filter-repo 重写)+GitHub 强推:客户敏感串(欣旺达/高文兵/电芯车间/电极辅助/数字化工厂/sunwoda)**四层 0 命中**。
- 过程文档归档出仓:D:/Documents/bim/archive-process-docs-20260924/;AI 记忆备份:D:/Documents/bim/archive-ai-memory-20260924/(记忆目录已清空);旧会话产物 565MB 已删。
- 注意:当前会话日志 model-io-sess_68937393-*.jsonl 在 ~/.zcode/cli/rollout/,关闭后手动删。

## 三、wasm 完整集成:精确剩余工作(用户拍板立项后执行)

已完成:全树 wasm32 编译 0 error(99 模块 #[path] 镜像在 deep-engine-wasm crate 根)、GraphSend 标记 trait(native=Send 约束/wasm 置空)、ControlFlow 五点 web_time 分支、GpuEvent::WasmRendererReady 事件变体已预置(events.rs,cfg wasm)。

剩余(按依赖序,估算合计 2-3 周全职;并行多路可压缩到 ~1.5 周):
1. **两段式渲染器初始化**(1-2 天):renderer_lifecycle.rs `initialize_renderer` 的 pollster::block_on(Renderer::new(...)) 在 wasm 主线程非法。方案:cfg(wasm) 走 spawn_local 异步初始化,完成经 GpuEvent::WasmRendererReady 回装;NativeApp 需加 cfg(wasm) 接收端字段;content 以 Arc<PlayerContent> 穿透(PublishedState<Arc<PlayerContent>>,构造点 app/mod.rs:363 一处)。
2. **场景包内存注入**(半天):JS `set_scene_package(bytes)` → 深层 load_and_validate 的 fs 读 cfg(wasm) 改读 OnceLock(deep-engine-native lib 加 pub static + setter;wasm 壳的 wasm_bindgen setter 调它)。
3. **winit web canvas 交接**(1 天):window_attributes()(lifecycle.rs resumed)cfg(wasm) 加 with_canvas(W2 已给双模式设计与源码行号,见 w2-report.md)。
4. **字体注入**(1 天):W2 实证 fontdb web 静默载 0 字体(无 fontique);需 FontSystem::new_with_fonts 显式注入字体字节(包内带字体或 JS 传字节)。
5. **执行器 wasm 单线程退化**(已完成编译层;运行时性能调优另计)。
6. **端到端浏览器联调**:engine.html 胶水页(W2 已建,EngineSurface 适配层)接真入口;真实场景包渲染截屏;触控/输入映射(W2 已设计 5 条差异对策)。
7. **极致优化**(用户硬要求):wasm-opt Oz 管线已建(W1);simd128 评估=体积中性暂不启用;atomics 需 COOP/COEP 不建议;体积门禁口径=bindgen 后(bench 基线 135.8KB)。

## 四、环境与命令速查

- 三方案对比页:http://localhost:5177/dev/wasm-bench.html(采集:apps/web/scripts/wasm-bench-run.mjs)
- 素材库 API:Bearer token(login admin/admin→/api/auth/login),GET /api/asset-library?limit=200&offset=N(共 1776 项,全 GLB,2.61GB)
- 素材库物理库:data/external-assets/source-a(models 2.7G/thumbnails 73M/thumbnails-normalized 105M/catalog/audit 含 sha256/pack.manifest 已生成)
- 素材包 Release:https://github.com/fatasia/bim-studio/releases/tag/asset-library-v1(3 卷 4.38GB 上传中)
- 音频长稳重跑:`DEEP_AUDIO_SOAK_SECONDS=1800 cargo test --test dashboard_video_media_foundation formal_exe_audio_thirty_minute_stability_soak -- --ignored --nocapture`(在 packages/deep-engine-native)
- Android 模拟器:AVD deep-test,WHPX 加速,adb 在 D:/Soft/adb/platform-tools(Git Bash 下 adb shell 参数加引号+MSYS_NO_PATHCONV=1)

## 五、诚实声明

- 30min 长稳 max 口径未过(三轮 400-500ms,定性=设备事件);mean 口径已切且达标(探针)。
- wasm 集成未完成:上表 1-7 全部为待办,当前只有编译基线+设计。
- Android Release 上传未完(后台进行中);GitHub 服务端可能缓存旧 SHA 孤儿提交(彻底清除需 Support 或新仓)。
- 工作树剩余未跟踪:scripts/benchmarks/babylon-web/(留置)、bindgen 产物(gitignored)。
