# 商业 BIM 平台 功能差距分析

更新时间：2026-08-03。比较对象是 商业 BIM 平台 当前公开的模型浏览、模型服务、图纸与场景能力；iTwin Studio 当前定位仍是内网轻量场景编辑器，不追求一次性复制完整商业平台。

## 已具备的基础能力

- IFC、GLTF/GLB、FBX、DXF 查看，RVT 转换器插槽
- 多模型场景、模型与内部节点树、显隐、透明度、变换与场景级删除
- 轨道、第一人称、第三人称漫游和独立角色显隐
- 距离、构件最小距离、角度、标高测量，正方体和标签等场景对象
- 场景管理、真实 URL、JSON 配置与 `.bimscene` 单文件交换
- 基于运行时构件索引的搜索、楼层/类别筛选、定位和隔离
- 剖切盒、轴向剖切、拾取面剖切、方向反转和构件爆炸
- 模型/图层锁定，Revit 房间与 MEP Space 提取、空间树、空间体显隐、稳定定位和结构化属性
- 标签拾取、编辑、锁定、定位及场景持久化
- 对模型和正方体的 BVH 三角形硬碰撞、碰撞对列表和定位

## 核心差距与优先级

| 优先级 | 商业 BIM 平台 能力 | iTwin Studio 当前差距 | 建议实现 |
| --- | --- | --- | --- |
| P0 | 云端转换、轻量化、超大模型流式加载 | 格式少；RVT 依赖外部 Agent；GLB 多为整文件加载，没有分块、LOD、按需加载 | 建立转换 Worker、Draco/Meshopt、空间分块、LOD 与缓存清单 |
| P0 | 结构化构件数据、构件树、属性 REST 查询 | 已有客户端稳定 ID、扁平属性和检索索引；仍缺转换阶段统一属性文件、服务端 REST 索引 | 转换阶段输出 `hierarchy.json`、`properties.json`，服务端建立属性索引 |
| P0 | 剖切面/剖切盒、爆炸、标准视角 | 已具备剖切盒、轴向/拾取面剖切、多方向爆炸和六向视角；仍缺剖切结果封口与正交相机 | 增加剖切封口、正交/透视切换和视图收藏 |
| P0 | 构件筛选、隔离、定位、按条件着色 | 已有名称/属性搜索、楼层/类别筛选、隔离和定位；语义质量取决于源模型元数据 | 增加选择集、专业筛选和批量规则着色 |
| P0 | 硬碰撞、间隙碰撞、选择集 A/B、结果列表 | 已有客户端 BVH 三角形硬碰撞、构件对和定位；缺间隙碰撞、后台任务与报告持久化 | 把 BVH 检测迁入 Worker，增加选择集 A/B、容差和检查报告 |
| P1 | 距离、角度、构件最小距离及对象捕捉 | 已有四类测量及原生网格 BVH 最小距离；缺端点/边/面捕捉，部分 Fragments 会退回点击点 | 增加捕捉提示和 Fragments 构件级最近点适配 |
| P1 | 模型版本对比 | 尚未实现新增、删除、修改识别 | 依赖稳定构件 ID，对两版 hierarchy/properties/geometry 做差异任务 |
| P1 | 批注、二维标签、问题定位与视点 | 已有三维锚点标签及构件绑定；缺箭头/区域批注、截图、责任人和问题流转 | 在现有标签数据模型上增加视点截图、状态、责任人和协同记录 |
| P1 | 共享坐标、多专业集成和自动对齐 | 当前靠人工变换组合模型 | 解析 Revit/IFC 坐标和单位，增加基点对齐、坐标校准与变换记录 |
| P1 | 房间、空间关系、轴网、楼层与明细表 | 原生 RVT 已提取房间/MEP Space、楼层、面积、体积、参数和边界盒，支持空间体显隐、定位和结构化属性；缺边界编辑、构件/设备空间关系和 RVT 写回 | 转换时生成 `spaceId → elementIds` 关系，增加空间隔离、网页侧属性编辑和设备归属，再通过 Revit API 选择性写回 |
| P1 | 数字孪生标签、锚点、动线、粒子和路径动画 | 能播放模型自带动画，但没有可视化特效编辑器与数据绑定 | 建立 Effect/Binding 数据模型，接入 WebSocket/MQTT 后映射颜色、数值和动画 |
| P2 | 完整 DWG/RVT 图纸、布局、拆图、捕捉和图纸批注 | DXF 仅基础线框；按当前产品范围 CAD 不是重点 | 保留独立二维 Viewer，后续再选择 ODA/商业转换服务 |
| P2 | BIM+GIS、地图、地形、3D Tiles、地理坐标 | 当前是局部 Three.js 场景 | 有园区/CIM需求时再接 Cesium，避免现在引入双渲染内核 |
| P2 | 分享链接、权限、审计、版本、协同 | 当前主要是内网单项目状态存储 | 增加用户、角色、场景版本、操作日志和带有效期分享链接 |
| P2 | 手机和平板适配 | 当前桌面三栏布局优先 | 核心查看器稳定后再做响应式工具栏和触摸交互 |

## 推荐开发顺序

1. 结构化构件 ID、层级和属性数据。
2. 搜索、筛选、隔离、批量着色、定位。
3. 剖切、爆炸、标准视角和精确测量。
4. 精确碰撞任务及碰撞报告。
5. 版本对比、批注与视点。
6. 数字孪生数据绑定和特效编辑。
7. 根据真实项目需求再选择二维 CAD、GIS 和协作平台能力。

## 参考

- [商业 BIM 平台 功能概述](https://商业 BIM 平台.com/intro)
- [商业 BIM 平台 支持格式](https://商业 BIM 平台.com/docs/model-viewer/v1/developers-guide/supported-translations.html)
- [构件状态编辑](https://商业 BIM 平台.com/docs/model-viewer/v1/developers-guide/edit-components.html)
- [模型测量](https://商业 BIM 平台.com/intro/430)
- [模型集成配置](https://商业 BIM 平台.com/docs/model-viewer/v1/developers-guide/integration-config.html)
- [发起碰撞检测](https://商业 BIM 平台.com/docs/model-data-service/v2/api-reference/createClashDetectiveUsingPOST.html)
- [文件对比](https://商业 BIM 平台.com/docs/model-derivative/v1/developers-guide/file-compare.html)
- [图纸概念与捕捉](https://商业 BIM 平台.com/docs/model-viewer/v1/developers-guide/drawing-introduction.html)
- [场景效果编辑](https://商业 BIM 平台.com/docs/model-viewer/v1/developers-guide/edit-effects.html)
