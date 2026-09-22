# 围栏 / 道路连续铺设闭环（2026-09-22）

本切片把既有参数化围栏和直路接入同一条结构路径、属性编辑、场景预览与 Deep 发布链。路径是静态搭建状态，不复用 AGV / 车辆的运动路线。

## 复用的现有能力

- 几何继续使用 `buildParametricFence` 和 `buildStraightRoad`，资源目录、插入命令、场景对象 ID、Inspector 容器和快照持久化链保持不变。
- 编辑历史继续使用 `recordSceneEdit` 的 220ms 合并窗口；连续输入只生成一个撤销事务，不新增历史系统。
- Three 编辑器和 Three WebView 继续消费 `IndustrialPrefabInstanceState` 与 `industrialPrefabProxy`；Deep Web / Native 继续消费统一 `RenderPacket` 和运行包。
- 道路标线继续使用既有 `InstancedMesh`；新增批处理只处理沿路径重复生成且几何、材质和阴影语义一致的构件。

## 本次新增

- `placementPath` 合同：2..512 个稳定端点、折线 / centripetal Catmull-Rom、闭合、贴地开关和固定 uint32 seed；合同校验拒绝重复 ID、非有限坐标和非法 seed。
- 围栏与道路定义增加 `pathCapable`。新实例自动创建本地起止点，长度从现有围栏 / 道路参数推导，seed 由 definition ID 稳定生成。
- 属性面板开放路径类型、闭合、贴地、seed、端点 XYZ、增删端点。路径参数修改立即重建预览，并进入现有合并撤销事务。
- 贴地使用场景真实几何的向下射线；计算同时扣除隐藏 primitive 的底面偏移，保存的是能让生成几何实际落在命中面的本地坐标。射线使用独立 `Raycaster`，不会污染选择射线状态。
- 折线 / 样条按有界段数生成连续围栏或道路；重复立柱、网条等构件折为 `InstancedMesh`。固定 seed 决定围栏门所在分段，重载和发布结果一致。
- `sceneSnapshotToRenderPacket` 对 path-capable 围栏 / 道路不再笼统拒绝 prefab。发布编译复用同一程序化生成器，输出稳定几何、PBR 材质、实例变换和对象到全部 part 的 binding；透明度、显式 PBR 覆盖、轮廓与静态自发光进入 Deep Web / Native 合同，未适配材质字段继续明确阻断。

## 验证

- Contracts：`industrialPrefabValidation` 与 `sceneValidation`，23 项通过；Contracts typecheck 通过。
- Web 路径、目录、Inspector、围栏 / 道路代理、实例化、贴地、RenderPacket、运行包与场景编译共 82 项不重复的聚焦测试通过；Web typecheck 通过。
- 程序化围栏和道路均构建并校验 Deep runtime package；场景编译确认不请求外部模型资源，并把同一作者对象绑定到全部生成实例。
- `git diff --check` 无补丁格式错误。按当前执行准则未跑全量、未做清理。

## 保留边界

- 端点和样条当前在属性面板中精确编辑；视口内可拖拽控制柄、控制柄拾取与吸附预览尚未实现。
- T 字 / 十字路口的拓扑生成、道路连接点自动焊接和绿化沿线散布不在本切片内。
- 本切片证明 Three 作者预览与 Deep Web / Native 运行包使用同一生成输入和可消费合同；最终 Native 可执行文件打包、真实窗口画面对拍与键鼠终验仍归最终发布测试。
