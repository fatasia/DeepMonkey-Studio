# C5 Bullet 测试参照

固定开源 Bullet，只用于独立物理测试；不进入产品运行依赖。

## 现状核查

1. 已检索 packages/apps 源码及当前未跟踪清单：没有 Bullet oracle；Rapier 黄金和布料 XPBD 已有，不重建。
2. 合同已有 ScenePhysicsBodyState/ScenePhysicsJointState；布料是现有局部 physicsTypes/ClothSolver 合同，无需扩公共 ABI。
3. Native Rapier 固定 0.35.3、Web compat 固定 0.19.3。Python 3.13 本机没有 pybullet；D:/Download 与本机缓存未找到 Bullet。优先固定上游发布源码或可验证 wheel，隔离安装，不修改产品依赖。
4. 既有黄金消费真实 NativePhysicsHost、PhysicsWorldHost、ClothSolver；现有 t17-compare-cross-tolerance 读取双端逐步位姿。
5. 已读 Native/Web stack、hinge、T18 cloth 黄金与 test-output/t17-cross-tolerance；输出载体存在，不能拿历史文件冒充本次执行。
6. 权威清单 C5 是 T17/T18 与 Bullet 独立对照记录；不包括 Harness C5 或已排除的 GIS 同编号任务。已读 T17/T18 实施报告和本日剩余估时。

**已有（不重建）**：双端刚体、机构和布料核、逐步位姿导出、确定性与解析黄金。

**真实缺口**：固定版本、许可证/哈希来源、独立 Bullet 输出及差异说明。首次先对齐三箱堆叠输入和布料自由落体/固定锚点边界；机构马达和有限刚度求解的语义差异需独立记录，不强求异算法逐位相等。

续接核查：Web/Native 的 runHinge 与限位/无限位控制组已存在，但没有逐步角度导出。只给既有黄金增加证据出口，复用其真实马达/关节装配；Bullet 使用同尺寸、质量、Z轴、限位和速度目标的测试期 URDF。strength 与 Bullet max force 的算法语义分别登记，不能据同数值宣称完全等价。

有限刚度续接核查：实际ClothSolver为右/下结构边与双对角距离约束，柔度单位m/N；固定Bullet源码 `btDeformableMassSpringForce.h` 按每条link施加 `k*(length-restLength)`，阻尼是边速度差而非宿主速度缩放。新增独立2×2平面校准子集，四个三角面覆盖六条唯一边，双方每节点0.2kg、初始无扰动、阻尼0、刚度40N/m对应柔度0.025m/N、上方两节点固定。只运行60帧、每帧8子步，同物理参数并不保证异求解器逐位相同；预注册最大节点位置差≤0.002m，锚点≤1e-6m与两轮稳定。原12×12不等价场景照常保留，禁止用该子集删除其8.89m finding。

首次8子步实际最大差0.007763160253m，未过0.002m门；锚点2.10734242e-9m且重复稳定。下一步保持物理参数和误差门，将双方同时增加至32子步，检查离散误差是否收敛；8子步失败保留在证据中，不改产品默认步数或求解器。

32子步最大差0.002167866170m，下降72.1%但仍未过门。最后对双方64子步检查收敛；若仍失败则记差异而不扩大阈值。该过程是测试期数值步长收敛，新增64子步不会进入产品默认配置。

最终默认fresh runner实际重采8/32/64三档各两轮：最大节点位置差依次0.007763160253/0.002167866170/0.001104484223m，64子步进入原0.002m门，所有锚点最大2.10734242e-9m且重复稳定。原两档失败也保存为false，而非只留下成功档。该2×2六边相同有限刚度子集已验；原12×12拓扑/阻尼不等价场景和完整布料家族保持finding，不把局部收敛写成完整材质准确度。

## 执行范围

新增测试期 Python oracle 与独立比较器，记录实际包版本、输入、两轮结果、重复性、每步位姿误差。参照安装仅在 test-output/c5-bullet；输出由现有黄金执行产生。装载失败明确报错。完整机构/布料有限刚度 oracle 未经过实测前保持待办。

## 固定来源与构建

- 源：PyPI 官方 `pybullet==3.2.7` sdist，SHA-256 `042879db8d101ac7590dee475fc6aded508b85fe1273fdbbfde1d88bd200e14f`；下载元信息保留在 `test-output/c5-bullet/download/source.json`。
- 本机 CPython 3.13.9 / MSVC 2022 17.14.12，执行上游 `setup.py bdist_wheel`；仅源码原样编译。隔离 wheel SHA-256 `f582a1fe557b3d1c2dee5e2420822683dc5b20211bab70f3bd6f778816303f78`，API 202010061；不修改全局 Python 或产品 package/Cargo 依赖。
- 顶层 LICENSE 为 zlib，明确排除 Extras 和 examples/ThirdPartyLibs 的统一授权；原源码、第三方 notices 和 wheel 本地保留。本切片未把第三方二进制纳入产品分发，也未宣称整个 sdist 都是 zlib。
- 无 Windows 官方 wheel，本机缓存亦无，初次 pip 下载的临时 tracker 失败；改用官方元信息直接下载并核哈希，发现实际 MSVC 安装位于 D:/Soft/IDE，已本地成功构建。不把依赖缺少当作阻塞。

安装准备：核验上述 sdist 后原样解压到 `test-output/c5-bullet/source`，在 VS 开发者命令环境运行 `python setup.py bdist_wheel --dist-dir ../../wheel`，解压生成 wheel 到 `test-output/c5-bullet/site`。参照入口 `node scripts/c5-bullet-oracle.mjs`；`--compare` 明确只比较历史文件。Python 可通过 C5_PYTHON 选择，必须能加载该固定包。

## 实测

默认 fresh runner 实际执行 Web/Native 三箱与限位铰链黄金、现有 XPBD 布料和 Bullet DIRECT，证据 `test-output/c5-bullet/evidence.json`，currentRun=true。重复两轮逐位稳定；来源和输入指纹已验。比较器 3 项拒绝测试通过，含旧输入、错误版本、缺输出、重复漂移、移动锚点、自由落体偏移与铰链越限。

| 测量 | 结果 |
|---|---:|
| 堆叠全程 Bullet/Web 最大位置差 | 0.00901723324 m |
| 堆叠全程 Bullet/Native 最大位置差 | 0.01000846181 m |
| 堆叠全程最大转角差 Web/Native | 0.02542625118 / 0.02539721970 rad |
| 限位铰链全程 Bullet/Web 最大角度差 | 0.02772055041 rad |
| 限位铰链全程 Bullet/Native 最大角度差 | 0.03327996599 rad |
| 匹配无阻尼自由落体最大差（30帧，每帧8子步） | 3.37176145e-8 m；预注册门5e-5 m |
| 固定布料锚点最大漂移 | 3.37176878e-8 m；预注册门1e-6 m |
| 有限刚度布料全程最大位置差 | 8.890696565 m |

`passed` 只表示参照执行/身份/重复性和上述边界合同，`accuracyEquivalent=false`。堆叠采用 Bullet 摩擦乘积规则的 sqrt(0.6) 对应 Rapier 平均0.6；接触 ERP/slop/迭代算法仍不同。三端铰链全程在±0.55rad内、最终角在0.45–0.55rad，无限位控制组最终角超过1rad；Bullet max force10 与 Rapier strength10 的马达语义不同，角度轨迹仅记录差异。布料 Bullet 三角弹簧 stiffness40/damping0.1 与 XPBD 零柔度、双对角结构和子步阻尼0.01不等价，8.89m差异保留为 finding，不能据此验证产品布料准确度。后继先匹配有限柔度/阻尼/拓扑语义，再补齿轮/滑轨参照；完整 C5 保持待办。
