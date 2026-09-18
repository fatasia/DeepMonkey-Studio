# Deep2D 场景编译与 Native 互通基线

日期：2026-09-15。范围：保存的场景快照 → 静态 Runtime Package → Windows Native 结构读取与 GPU smoke。

## 当前证据

| 夹具 | 几何 / 实例 / 纹理 | Native 结构检查 | GPU 提交 | 篡改拒绝 |
|---|---|---|---|---|
| 七种基础体 | 7 / 7 / 0 | 通过 | 通过 | hash mismatch |
| Box 双实例 | 1 / 2 / 0 | 通过 | 通过 | hash mismatch |
| BoxTextured 双实例 | 1 / 2 / 1 | 通过 | 通过 | hash mismatch |

运行环境：Windows x64，NVIDIA GeForce RTX 4060 Laptop GPU，Vulkan，Bgra8UnormSrgb。
三组均报告 GPU `scopes=clean callbacks=clean`，64×64 smoke 帧已呈现；LKG 在 present 后提交。
原生程序由当前工作区 `cargo build --bin deep-engine-native` 构建。
本次 EXE SHA-256：`78a1bffc20f10abf03c8bfd2527fcc0d2a9616987c6258341d5c9b78aeed27fb`。

三组使用实际 `compileSceneRuntimePackage`，不是手写 Runtime Package JSON。
模型源自已有、带来源与许可记录的引擎夹具；脚本核验 sources.json 中的源文件摘要。
BoxTextured 通过现有 sharp 解码 PNG，再经已有 GLB 纹理管线写入像素，Native 报告 1 张作者 sRGB 纹理。

## 复跑

在仓库根目录执行：

```powershell
cargo build --manifest-path packages/deep-engine-native/Cargo.toml --bin deep-engine-native
node apps/web/scripts/verify-scene-runtime-interop.mjs packages/deep-engine-native/target/debug/deep-engine-native.exe --gpu
```

仅检查合同可将 `--gpu` 改为 `--headless`。
每次生成独立 `test-output/deep2d/scene-interop/<run-id>/`，包含运行包、编译证据、输入文件摘要、编译 bundle 与 report.json。
脚本将产物字节 SHA-256、包内 canonical hash、EXE 摘要分开记录，并对篡改版本字段的包断言非零退出及 hash mismatch。

本次最终报告：[report.json](../../test-output/deep2d/scene-interop/39b26160-9cd5-4832-afac-90bbc2a9511f/report.json)。
这些运行产物留在本地，不提交原始日志或二进制。

## 尚未通过

- smoke 不比较作者画面或像素；不授予 Native 完整窗口能力证据。
- 相机、环境、二维、行为仍有未编译字段；正式导出入口尚未调用新编译器。
- 未验证任意客户模型、动画/蒙皮、原生中文文本、IME、动态数据或长稳性能。
- 未完成两轮正式浏览器/Native 视觉验收，也未完成 P0 整体发布验收。

下一步是将相机及宿主场景配置接入同一校验/提交链路，随后接 D02 能力报告与正式导出。
