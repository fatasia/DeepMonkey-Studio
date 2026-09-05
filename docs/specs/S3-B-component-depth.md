# S3-B 2D 组件目录深度与 300+ 预设

## 0. 元信息

- 状态：规格已完成；实现为本轮待办。
- 批次：S3；依赖现有组件目录/渲染器与 EX-002 绑定交互，语义槽位依赖 S1。
- 触碰域：2D、contracts；分批交付，每批 ≤2 小时验证，不一次填满数字。

## 1. 目标与用户故事

用户从可搜索组件目录找到适合业务的预设，拖入画布后直接绑定字段、调整展示、预览和发布。300+ 指可用预设，不是 300 种独立渲染器；装饰素材与功能预设分别统计，颜色/标题变化不独立计数。

## 2. 现状与复用

- `DashboardComponentCatalog.ts` 汇总指标、分析、报表、工具和四类装饰目录。
- `DashboardComponentCatalog.test.ts` 已检查 ≥80 功能预设、≥60 装饰、ID 唯一及合法可编辑节点。扩量前由实际导出数组统计基线，禁止凭文档累加。
- `DashboardComponentLibrary.tsx` 保持图表/控件/媒体/3D/资源五个入口；不新建第二个资源库。
- `dashboardComponentPresetTypes.ts` 的 `DashboardComponentPreset` 与现有 `SceneDashboardWidgetType` 保持兼容；配置仍归右侧检查器。

## 3. 合同设计

新增目录元数据文件而非改变所有场景合同：`dashboardPresetCapabilities.ts`。

```ts
interface PresetCapabilityDescriptor {
  presetId: string;
  familyId: string;
  purpose: { zh: string; en: string };
  semanticSignature: string;
  bindings: Array<{ role: 'dimension' | 'measure' | 'time' | 'label'; required: boolean; maxFields: number }>;
  interactions: Array<'filter' | 'drill' | 'navigate' | 'writeback'>;
  sampleFixtureId: string;
}
```

该类型是目录能力声明，不是运行时授权；不得声明尚无 renderer/action 支持的功能。必填槽位缺失时显示配置入口，空数据不伪造指标。已有场景只存原节点配置，新增目录元数据不要求迁移。写回只复用受控写入链路，不让装饰组件取得写权限。

## 4. 实现要点

1. 先生成目录审计：按功能族/装饰/渲染类型计数；同语义签名检测重复，目录 ID 稳定。
2. 按设备健康、质量追溯、能耗、仓储、工单、产线节拍分批增补；每项必须定义用途、数据槽位、交互、空/错态。
3. 已有 renderer 能满足就加预设；确需新 renderer 时独立组件和合同测试，不为数量扩枚举。
4. 缩略图来自相同配置，不能“图看起来有但插入后不是它”。列表搜索/键盘插入/最近使用复用原有状态边界。
5. 每批修改文件目标 ≤300 行；超大文件只按稳定职责减负，不机械切片。

## 5. 测试计划

- 目录测试：ID/签名、字段槽位、合法节点、旧 ID 可打开、样例非空、零值/null/错误可区分。
- renderer 族各测一次交互与数据绑定，预设逐项测配置合法；不能只测数组长度。
- 浏览器：查找→拖入→换真实字段→保存→刷新→预览→发布到专用 QA 项目。禁止覆盖用户场景。
- 1440/980 双主题截图；控件聚焦/空态/长名称/字段错误；console 无产品错误。
- 命令：Web 聚焦测试、全仓 typecheck、Web 全量、source-size、相关编辑器门禁。

## 6. 验收标准

- [ ] ≥300 有意义预设，功能/装饰分别公示，颜色副本不计数。
- [ ] 每个功能族拥有数据和交互证据，不以缩略图代替运行能力。
- [ ] 目录插入、语义绑定、保存恢复、公开浏览一致。
- [ ] 行为、双主题及键盘验证通过，性能与基线比较无回退。

## 7. 风险与回滚

最大风险是凑数、预览与真实配置漂移、数据槽位承诺超过 renderer。按领域族独立本地提交；回退时只隐藏新增目录项，保留已保存节点的兼容读取，不删除用户数据。

## 8. 完成回填

2026-09-05：规格已完成。300+ 实现与验收均为本轮待办；未把现有装饰/模板总数混算为已完成组件数。
