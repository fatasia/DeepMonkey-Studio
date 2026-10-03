# B1 材质作者源码命令最小接线（2026-10-02，主线程）

## 现状核查

1. 全仓源码/未跟踪：`SceneMaterialCommandPatch`现有Pick只列基础颜色/金属粗糙/UV等，不含已存在SceneMaterialState.customShader。Viewer setModelMaterial消费实际作者override+userData，真实shader package编译仅在delivery。
2. 契约：公共contracts早已有 `{source:string}`，只扩SDK Pick不造clearcoat scalar。Worker源是不可信数据，沿inspectRecord/getter/proto安全检查。
3. 依赖：不引入库，沿sceneCustomShader编译前置门、Vitest及UTF8 TextEncoder。既有作者上限32KiB。
4. 消费：SDK→SceneCommandExecutor→ViewerSceneCommandPort→setModelMaterial→快照保存。graph owner的primitiveMaterial编译未支持源，自然保持明确拒绝；不强放不支持profile。即时Deep/Three未挂ShaderPackageExecutor，不得宣称用户能看到clearcoat实时效果。
5. 测试：沿commandValidation/sceneCommandTransaction与ViewerPort测试；缺非空/长度/非法结构、unknown/getter、权限/跨scene、锁对象、编译错误零变更。
6. 规格：P4 B1仍partial，第二路负责作者compiler明确profile与runtime v3能力协商，主线程只SDK/Viewer端守卫，无UI改动/步骤。

**已有（不重建）**：customShader作者类型、源码预览编译、保存重开、材质事务权限/回滚。
**真实缺口**：源码不能走已有material.set命令；ViewerPort把锁定对象被无声忽略的修改也报applied；源码IO边界未经nested安全校验。

## 最小方案

- SDK Pick existing customShader；parser允许仅source字符串/清除undefined，与现属性清除语义一致，非空UTF8≤32768，nested额外字段/getter/proto拒绝；沿studio.material/studio.object权限。
- Viewer端先判lock（所有材质同族），源码有值先inspect编译，失败返回unsupported人读错误，成功才写author override；**作者保存，不等同即时画面**。
- graph未支持编译profile仍整批拒绝，不为命令白名单伪造consumer。
- 至少正向保存/清除＋4非法形态/权限/取消/CAS/编译错误/锁对象负控，实际源码与第二路传来的v2/v3source同步。
- 本批没有新增页面、面板、按钮、对用户暴露内部profile选择。CPU先验，真实draw后继原门不关闭。

## 实测

- SDK全量 **123/123**，源码新增11用例含exact whitespace/UTF8上限/unknown/getter/revoked proxy/scene mismatch/permission/capability；短路径断言status=prepared/rejected实际生效，不以toBeDefined造绿。证据 `test-output/b1-material-source-20261002/sdk-final.json`。
- Web原driver/executor/port/delete/graph聚焦 **73/73**，真实Viewer原型+Three材质的作者state读回 **2/2**：source写author override与实际userData、snapshot JSON保真，非法source连同color混patch在编译前拒绝、旧源码不变。`web-final.json`、`real-author.json`。
- SDK/Web完整typecheck均exit0。首轮单行DeepSL夹具不合法失败保留，改为已有官方多行例，不更改编译器语法；测试权限request初版误用函数shape已自查修正为实际单参module，原权限断言实跑。
- Viewer对象锁检查先于材质调用；非法编译返回unsupported人读信息、无材质mutation。没有新增UI、面板、按钮或profile选择；原页动线保持。

## 边界与不能关闭的部分

- `customShader:undefined`仅进程内清除，JSON会丢字段，HTTP清除另用现有编辑器清除流程；未造null wire合同。
- 保存作者源码不是即时渲染：现Viewer只存author状态，Deep stock/Three桥未接ShaderPackageExecutor真实draw；compile inspection成功≠画面。B1仍partial。
- graph primitive owner当前不支持custom源码编译，既有unsupported名单保持原子拒绝，不为SDK白名单伪造consumer。
- 第二路profileCompiler只在preview支持新v3，生产runtime/native默认v2拒绝，具体源包/stride能力见 `hc7p4-b1-author-profile-recovery-20261002.md`；未有跨端drawing认证，不关闭P4或I23整项。
- no cargo、no帧时、no commit/push；GPU独占归第一路F5。

## 接线收口（2026-10-02 主线程代第二路完成）

- `viewerEngineObjectState.applyMaterialState` 接入两 helper：`validateDeclarativeMaterialPatch`（任何换装前整批编译校验，非法源在任何 mutation 前抛错，与 IOR 原子性同规）+ `prepareDeclarativeMaterial`（clearcoat→Physical 换装、清源→基线恢复、共享贴图/屏幕引用随换装转移）。
- 测试修正到真实可观测面：换装后原材质被替换释放，断言读网格当前材质（不再是已释放的旧引用）+ override 数据态；初版三断言误用 API（拿数据态当 THREE 材质、读已释放原材质）已按实际语义修正——修的是测试，不是产品放宽。
- 聚焦四文件（MaterialSource/CommandPort/materialSlotsRuntime/sourceMaterialReset）全绿；声明式 lowering 三腿 3/3。真实 clearcoat 现在经标准材质系统可见（Physical.clearcoat），无新增 UI/控件/步骤。
- B1 状态：作者源码→编译→真实材质换装→保存重开全链 CPU 闭环；Native 默认 v2 守卫与 Studio 独立包路径仍开放，**保持 partial** 不冒充完成。
