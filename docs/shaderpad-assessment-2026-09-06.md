# ShaderPad：聚焦源码评估

状态：已完成静态源码评估；未安装、未运行其应用、未引入产品依赖。

来源：[GitHubJackson/shaderpad](https://github.com/GitHubJackson/shaderpad)，2026-09-06读取main，提交 `aaa21d678f94a2d2e8ba59d503dfd1f9243fe180`。用户第二篇微信正文未获取，以补充源码作为本评估依据。

## 结论

有价值，适合作为材质/着色器编写体验的参考，不是URDF/ROS工具，也不是成熟WebGPU双后端引擎。优先借鉴“代码、实时预览、错误定位、匹配样例”的小闭环，复用本站既有Monaco/Viewer/材质能力，不另造第二套3D编辑器。

## 源码而非宣传

- [运行时](https://github.com/GitHubJackson/shaderpad/blob/main/packages/shader-playground/src/runtime/three-engine.ts)实际采用WebGLRenderer+RawShaderMaterial；提供平面/盒/球、uniform更新和GLSL编译诊断。
- [TSL](https://github.com/GitHubJackson/shaderpad/blob/main/packages/shader-runtime/src/languages/tsl.ts)与[WGSL](https://github.com/GitHubJackson/shaderpad/blob/main/packages/shader-runtime/src/languages/wgsl.ts)明确 `implemented:false`，compile直接抛未实现；不能按README“adapter就位”当可用WebGPU。
- [React预览](https://github.com/GitHubJackson/shaderpad/blob/main/packages/shader-playground/src/ui/PreviewCanvas.tsx)适合学习职责拆分，但异步IIFE返回的ResizeObserver cleanup未被外层effect接收；这是静态可见风险，未运行复现。
- 运行时先dispose旧材质再应用新源码，没有最后成功材质保留；forceCompile只逐stage编译，没有完整program link校验。错误正则把WebGL `ERROR: source:line:`两数字当line/column，存在定位错误风险。不宜整包照搬。
- 子包有[MIT许可](https://github.com/GitHubJackson/shaderpad/blob/main/packages/shader-playground/LICENSE)；peerDependencies固定three ^0.170、Monaco ^0.50，与本站版本不同，不能直接装入假定兼容。任何实际复制须保留许可与署名。

## 最小采用方案（候选，未加入当前开发批次）

在现有材质入口补专用编写面板：左源码、右当前对象预览、底部可定位诊断；自动编译防抖+显式重试，源码错误保留最后成功画面；确认应用才写场景/撤销历史。现有生命周期脚本保持自动运行，不照搬playground手动Run作为场景生命周期机制。

区分GLSL/WebGL与TSL/WebGPU能力，完整编译+链接诊断、真实行映射、关闭释放、恢复/撤销和双主题门禁先过。时间/mouse/resolution只更新uniform，不逐帧重建材质或重渲染React。冻结本批只完成评估，避免为新想法打断既有收口。
