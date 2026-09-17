# P2-01：LPAC worker 进入 Windows portable 候选包

Windows portable 构建现在随主播放器编译并交付固定的 `bin/deep2d-x-worker.exe`。它仍是默认关闭的 X 实验通道，现有 Viewer 启动器不会执行它。

## 构建与信任合同

播放器与 worker 在同一锁文件、目标三元组和独立 `target/portable-windows` 目录中以 release + 静态 CRT 编译。打包不接受外部 worker 路径，也不在运行时下载或替换二进制。

manifest v3 增加 `compatibilityWorker`：固定 `experimental-x`、X schema v1、包内相对路径、SHA-256、`windows-lpac-zero-capability` 与 `defaultEnabled=false`。worker 仍只理解封闭 X ABI，不执行任意 JS/DOM、文件路径或网络请求。

通用 verifier 对包内 worker 重新执行路径约束、PE、静态 CRT/浏览器依赖标记与 SHA-256 检查。错误 lane/schema/sandbox、默认启用、缺文件、动态 CRT、禁用依赖或哈希变化均拒绝。该验证没有把哈希当签名；签名与撤销属于 P3-03。

## 实测

```powershell
& packages/deep-engine-native/scripts/package-windows-portable.ps1 -OutputRoot test-output/deep2d-x-portable
& packages/deep-engine-native/scripts/verify-windows-portable.ps1 -PackageRoot <package-directory> -ArchivePath <zip>
```

- 实际包：44 个 ZIP entry，5,884,968 bytes；ZIP SHA-256 `4af79a947e28a059fe541ab232cad7c0483b9bad4fc1913be3d2b1215b3f3e7e`。
- worker SHA-256：`b014ed385145a0ac2c5fa81bb86c52ddfd8ef4ca8877e45e9d55bf6c8426336d`；PE、静态 CRT、零浏览器依赖标记检查通过。
- portable verifier 回归通过；27 项实际 LPAC/GPU/恢复 smoke 在 Windows 11、RTX 4060 Laptop GPU/Vulkan 上通过。同步修正已有选择/测量 smoke 的脆弱连续子串断言，将两个真实状态分别核对；没有降低语义要求。
- 主播放器的显式 `--verify-x-worker` 诊断只解析固定同目录 worker，实际通过 LPAC 调度封闭 X 请求并核对回执。固定 request/output hash 分别为 `74b14cc2f45d36d6956291973c252cc58db750474903795f6afc729cd5caa40c`、`5925b7a665e0c952d0c15d2f86817434838c940ce99c5f73c25da3952e1c5dc3`。
- 二次独立 verifier 对目录、ZIP、checksum、payload、worker、shader、27 项 smoke 全部通过。

本片完成正式候选包工件及显式播放器诊断接线，不等于产品已允许动态内容进入 X lane。真实内容调度、用户级开关/诊断呈现、签名扩展、更新撤销和完整 Windows 权限/网络矩阵继续待办。
