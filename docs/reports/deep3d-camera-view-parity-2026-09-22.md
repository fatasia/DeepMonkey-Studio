# Deep 3D 多相机视图跨端接入（2026-09-22）

## 结论

Web 作者场景中的多个 `cameraViews` 之前只会选出默认视角写入 `scene-camera`，其余视角被发布预检标为未编译。现在复用同一份 `scene-camera` 资源，在保存视图全部为 `orbit` 且使用同一套 Native 导航约束时，把视图按作者顺序、局部坐标和默认 ID 写入 v5 相机合同；Native 读取后用数字键 `1`–`9` 切换对应视角，仍走既有碰撞、约束和相机发布路径。

## 没有重复建设的部分

- 继续复用 `compileSceneCamera` 的 FOV、裁剪、局部坐标和导航约束，不创建第二个相机编译器。
- 继续复用 `PlayerView::from_camera`、`PlayerState::set_camera`、既有 Renderer `set_view` 和碰撞解析，不新增相机状态机。
- 视图不拆成独立 RuntimePackage 资源，避免额外哈希、索引和热更新路径；它们属于同一个作者相机资源。

## 生产变化

- `RuntimeSceneCamera` v5 增加有界、唯一 ID 的 `cameraViews` 与 `defaultCameraViewId`，每个视图校验有限坐标、名称和 position/target 距离。
- 编译器仅在所有保存视图均为 `orbit` 时升级为 v5；混入 `firstPerson`/`thirdPerson` 会保留明确的 `uncompiled` 阻断。
- 发布兼容性报告把 `cameraViews` / `defaultCameraViewId` 映射到既有 `scene.camera` 资源和 `deep.scene.camera-views.v1` 能力，不把 CPU 编译结果当 Native 运行证据。
- Native 使用数字键与小键盘数字键切换 1–9 号视图；无对应视图时不消费按键，既有输入路由继续工作。

## 验证

- Web：`compileSceneCamera` 与 Native 发布兼容性聚焦回归 21 项通过；Web typecheck 通过。
- Deep Engine typecheck 通过。
- Native `cargo check --lib` 通过；v5 相机合同单测通过。
- Native 二进制聚焦测试受现有独立测试目标的模块装载差异影响，未把该目标结果扩大为全量 Native 通过；正式 EXE 的数字键、多 DPI、主题和画面对拍仍归最终统一验收。

## 保留边界

视图若使用第一人称/第三人称导航，仍需对应 Native 导航运行时后才能解除阻断；数字键只覆盖 1–9 个视图，超过九个视图继续通过现有视图 UI/后续输入合同扩展。该切片不宣称 Deep 3D 已完成全部 Web 交互或跨端像素等价。
