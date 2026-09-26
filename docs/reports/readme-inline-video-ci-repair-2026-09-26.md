# README 视频与 CI 修复

## 现状核查

- 已有（不重建）：README 的原介绍视频使用 GitHub user-attachments 裸链接，可在页面内播放；系统核心功能录屏已验证为 1920×1080 H.264/AAC。`Repository governance` 已有 5 MiB 门槛和带 SHA-256 的例外清单；Deep Engine 工作流已有浏览器、Ubuntu 与 Windows 原生检查。
- 真实缺口：新录屏使用仓内 MP4 链接，只能跳转文件页，且 34 MB 文件没有治理例外，导致 2026-09-26 的治理检查失败。Deep Engine 当次 Ubuntu Clippy 报三个源码问题：非 Windows 平台未使用的 `PathBuf`、未使用的 MP4 验证函数转发，以及 Linux 下无效的结构体更新。
- 核查范围：全仓检索 README 视频、徽章、两份 workflow、相关包源码及未跟踪文件；检查 `packages/contracts/src` 和相关类型、根 `package.json`/Native `Cargo.toml`；追踪 MP4 验证函数调用点；查治理测试、Native 测试与 GitHub 失败日志；核对 `docs/specs`、`docs/handoffs` 和恢复记录。没有需要新增的合同或依赖。

## 修复方向

- 新录屏改用与原视频相同的 GitHub user-attachments 裸链接；上传得到的 URL 通过 GitHub Markdown 渲染 API 验证为 `<video>` 播放器。去掉仓内大文件和多余封面，遵守现有文件体量门槛。
- 只修复 Clippy 指出的跨平台条件编译和结构体初始化问题，保持工作流门槛不变。

## 验证

- GitHub Markdown 渲染 API 将新录屏链接生成为 `<video>`；远端 README 已显示该链接紧接原介绍视频。
- 2026-09-26 的 Repository governance 作业通过。Deep Engine 首轮重跑的浏览器、Windows 原生测试与 Clippy 通过；Ubuntu 测试和格式检查通过，但全目标 Clippy 继续指出二进制目标和示例中的 6 处平台条件编译警告，已逐处修复。
- 本地 Windows `cargo fmt --all -- --check` 与 `cargo clippy --locked --all-targets --all-features -- -D warnings` 通过；最终以 GitHub 双平台工作流结果验收。
