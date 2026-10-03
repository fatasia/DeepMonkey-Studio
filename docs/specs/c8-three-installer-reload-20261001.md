# C8 Three 安装器模块重载恢复

修复作者场景关闭后重新进入时，模块注册表重建但 Three 全局 shader chunk 已适配的初始化失败。

## 现状核查

1. 全仓检索生产源码和未跟踪项：`threeDisplayToneMapping`、`threeMaterialMath` 已在主线程与 offscreen worker 使用；全仓没有另一个安装所有权持久化实现。`git status --short` 已核对，并行更改与四个保护项不动。
2. 契约层：`rendererCapabilityManifest.ts` 已声明 toneMapping 显示能力；安装器使用 Three 原有 ShaderChunk 字符串类型。恢复安装注册不新增场景/渲染合同。
3. 依赖：Three 固定 0.185.1，已有 Vitest。Three package exports 开放 `./src/*`；三个 ShaderChunk 源文件已有 default 字符串导出，独立于可变 `THREE.ShaderChunk` 属性。
4. 消费方：`ViewerEngine.create` 与 `offscreenScene.worker` 均在创建首个 WebGLRenderer 前调用两个安装器。应用清理会 dispose 引擎；不会还原 Three 全局 chunk。lab probes 也复用安装器，部分 lab 会保存并恢复原始 chunk。
5. 测试/证据：已有两个安装器的同对象重复安装和后续漂移测试；tone 测试刻意拒绝新对象持有 adapted 文本。纯适配器分别锁定 ACES/Fresnel/GGX 原始定义并拒绝重复适配。主线真实浏览器报告第二次进入作者页出现 `Three tone-mapping shader changed or was already adapted`。原 wrapper 的 WeakMap 本来支持同模块同对象幂等；缺少模块重载后注册表丢失的覆盖。
6. 规格：已核对 C8 S2/S3a 显示链、S3b Fresnel、S3c GGX 与 20261001 交接、恢复 ledger。沿用正式共享数学，不修改 Three S5/S9 原始对照。

已有（不重建）：三个 pure adapter、共享数学库、两个生产安装点、同模块 WeakMap 幂等、shader 漂移守卫。

真实缺口：安装模块重载会丢失 WeakMap，而全局 shader chunk 仍保留适配源码；新安装器再次把 adapted 文本传给 strict pure adapter，触发拒绝。同族材质安装器存在相同缺口。浏览器报错与这个条件一致，原始浏览器 HMR 事件未单独记录；使用模块重载回归测试确认条件与失败。

## 修复合同

从固定 Three 源模块的不可变字符串计算本版本完整 canonical adapted 文本。首次安装与重认领都只接受完整正式字节；未知注释/公式/空白漂移、局部适配和旧数学版本全部拒绝。WeakMap 保留快速重复调用与后续漂移检查；首次 canonical 计算按模块缓存。pure adapters 继续拒绝 adapted 输入；没有全局标志。材质两块验证完才赋值。

源 `.glsl.js` 与发布版字节不同：发布构建剥除注释并合并空行。`threeCanonicalShaderSources.ts` 使用 [Three r185 官方 glsl 发布转换](https://github.com/mrdoob/three.js/blob/r185/utils/build/rollup.config.js#L3-L34) 的精确步骤，随后用旧适配器计算正式源码。三块与实际未适配 ShaderChunk 逐字一致测试通过，未知当前输入不经过 strip 或其他规范化。

## 视觉约束与验证

已读取 design-taste-digitaltwin。Design Read 对标 Unity 的 ACES/PBR 渲染生命周期稳定性；已有 base.css 令牌、布局、曝光、容差和 shader 数值不变。CPU 检查覆盖模块重载、重复关闭重开、完整正式字节重认领、外部变异和局部适配拒绝。真实作者页截图两轮及视觉验收由主线复验，本文只记录实际结果。

## CPU 验证与冻结

- 修前复现：两个真实 `vi.resetModules()` 回归均失败，5 项旧测试通过；错误分别为 tone-mapping 和 Fresnel 已适配 guard，与浏览器报告相同。
- 修后两个安装器 18/18 通过；其中共享 Three realm 使用默认全局 chunks，经两安装模块重载和材质 dispose 循环三次，正式源码始终相等。该 CPU 场景不创建 GPU renderer，真实 SPA 验收待主线。
- 未改的 pure adapters/display output/direct material profile：5 文件 27/27 通过，继续拒绝重复适配/漂移，保留原始对照策略。
- 严格聚焦 tsc 通过：`pnpm --filter @bim-studio/web exec tsc --noEmit --target ES2023 --module ESNext --moduleResolution Bundler --customConditions development --strict --skipLibCheck src/viewer/threeDisplayToneMapping.ts src/viewer/threeMaterialMath.ts`。首次独立 tsc 未带仓库 development 条件和 Node 测试类型路径，失败日志随后由正确条件的生产源检查覆盖。
- 两个测试文件也以相同 strict 条件及 `--types node --typeRoots ../../packages/deep-engine/node_modules/@types` 检查通过，复用已有引擎包 Node 类型，日志 `typecheck-tests.txt`。
- Vite/Rolldown 浏览器 helper bundle 解析通过；孤立辅助模块产物 32,505 bytes / gzip 9,002 bytes，1 chunk，无 renderer。只引入三个指定源 chunk；完整产品包压缩增量尚未比较。原始字节整理在模块加载时一次计算，共享数学适配在该模块首次安装时缓存，常规重复初始化不重算，渲染帧无新增工作。
- `git diff --check` 通过。证据：`test-output/c8-three-installer-reload-20261001/{before,after,pure-adapters,typecheck}.txt`、`bundle-check.json`；CPU 检查没有跑 GPU/Cargo。

生产源码冻结 SHA256：tone wrapper `b2125c1b95ae42065849d5e13602ed3daff2eeccd3dd57ce1bbbccb8855c7289`；material wrapper `5464063c7563061d016c1978b7b720be43c392a2337f170f730a57f5b09c2f9b`；canonical source helper `4c935bf6b5c4efebf8bdd6fecccdc8a72a5e8a81b20ee67f6c4a201105070177`；精确类型声明 `8cce1005c681bb4872b1d82870561160483a79cdcb5bdc7113f41c2c39e85d3d`。
