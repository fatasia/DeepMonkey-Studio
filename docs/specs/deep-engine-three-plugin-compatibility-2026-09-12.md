# Deep Engine：Three 高频兼容门槛

日期：2026-09-12。2026-09-13 用户删除“完整 Three 插件逐个兼容”。当前只覆盖项目实际使用的高频标准对象/材质、glTF 资产链、控制器、BVH、动画和明确 P0 插件；未知或私有渲染扩展只输出机器可读兼容报告。

## 合同

继续使用同一份作者对象及同一脚本宿主。插件所持有的 Scene、Object3D、Geometry、Material、Texture、相机和动画对象引用必须保留；保留原型、事件、raycast、userData、订阅和闭包。渲染提取仅获得自有数组，不调用作者 dispose、不通过 clone/序列化替换作者状态。

兼容面分为数据/交互、glTF 资产与动画三类，各自独立验收。涉及 WebGLRenderer、WebGLRenderTarget、任意 GLSL、onBeforeCompile、Composer 私有 Pass 或 renderer hook 的插件不做逐项替代，统一报告 `unsupported` 并继续使用旧 Three 后端。

## 首批冻结语料

版本以本仓锁文件和实际加载包为准。当前产品 Three 0.185.1，three-mesh-bvh 声明 ^0.9.14，urdf-loader 0.13.1，@thatopen/fragments 3.4.5。测试包仅添加与产品匹配的开发依赖，不把 Three 作为自研核心运行时依赖。

| 实际入口 | 必须验证的行为 | 当前状态 |
|---|---|---|
| three-mesh-bvh；ordinaryPicking / analysis | 原 geometry/BVH/raycast 引用、拾取对象与距离、移动/变形后更新、卸载 | 本轮待办；固定版本基础 identity/raycast 已完成 |
| GLTFLoader、DRACO、KTX2 | 真实 glTF/GLB 导入、材质/纹理/层级/扩展、资源共享和失败释放 | 本轮待办；Box GLTFLoader.parse 基础已完成 |
| AnimationMixer、SkeletonUtils | 时间、混合、骨骼、morph、事件与同一闭包跨切换连续 | 本轮待办；基础 Mixer 事件/闭包与 clone 共享资源已完成 |
| 控制器、Gizmo、选中与交互工具 | 相机/对象 identity、DOM 输入、拖动与事件、拾取 | 本轮待办 |
| @thatopen/fragments | 只覆盖当前项目实际使用的对象生命周期、加载/卸载和切换合同 | 本轮待办 |

## 完成条件

- 清单只包含实际 P0 依赖的固定版本、源文件哈希、使用 API、必需语义、验收用例和结果；不建立生态全量插件队列。
- 产品实际使用及文档承诺的 P0 插件语义 100% 通过。运行真实第三方代码，验证结果、identity、异常和资源；不只用 mock，也不只断言“不抛错”。
- 在同一作者场景上完成 Three→Deep→Three，保持相机、选择、动画/仿真时间、脚本闭包和插件事件连续；验证连续切换、取消、失败、迟到资源与设备恢复。
- 未支持/未验证的必需插件应在预热与发布新后端之前被拦截，旧 Three 继续工作，提供插件和能力的明确原因。后备路径保护现有项目，不能将其计作自研兼容通过。
- 整体画质、性能与资源门禁仍按主计划执行。库升级或相关源文件变化后复验，禁止继承旧版本的兼容结论。

## 当前实测证据

固定 `three 0.185.1` 与 `three-mesh-bvh 0.9.14`，真实运行 `computeBoundsTree` / `acceleratedRaycast`、`AnimationMixer`、`GLTFLoader.parse` 读取原始 Box.glb、`SkeletonUtils.clone`。投影前后 Mesh、Geometry、Material、BVH、raycast、Mixer root、闭包和 finished 事件连续；基础桥接与插件联合 14 项通过。用例见 [realThreePlugins.test.ts](../../packages/deep-engine/src/pluginCompatibility/realThreePlugins.test.ts)。

自定义 `material.onBeforeCompile` 与 `object.onBeforeRender` 当前返回结构化 `unsupported`，这就是预期边界。移动/变形后的 BVH 更新、骨骼动画、控制器、当前项目 `@thatopen/fragments` 用法和实际产品切换仍待完成；其它 loader、Composer/TSL 和未知插件不进入任务。
