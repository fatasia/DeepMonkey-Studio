# 开源素材、模板与组件交付

源码仓库启动时会带上可公开再分发的内置素材和示例；用户上传的模型、图片、视频、字体和业务数据不应提交到仓库。应用把两者分开显示，发布项目时只打包当前项目实际引用的版本。

## 克隆后能直接使用什么

- `apps/web/public/assets/nature-kit` 随 Web 构建提供 48 个已筛选 GLB 与缩略图。目录包含 `catalog.json`、来源地址、SHA-256、内容哈希和 CC0 许可文件，可用于公开示例和本地离线演示。
- `apps/web/src/components/dashboardTemplateCatalog.ts` 及行业目录提供看板模板定义、布局和示例数据；它们是源码目录，不依赖私有服务启动。
- `apps/web/src/prefabs` 与 `apps/web/src/components` 提供工业预制体和二维组件目录；组件的行为、样式和合同随源码发布。
- `apps/web/public/samples` 提供可公开的 CSV 示例；业务模型、现场图片、供应商权重和客户数据不在仓库中。

首次启动不需要网络素材服务。若构建产物中没有内置模型，先检查静态资源是否被打包以及浏览器网络面板的路径；不要把缺失的客户文件复制进仓库来“修复”示例。

经过授权审计的素材包可用命令导入：`pnpm assets:import -- ./packs/open-library.zip --target=./data/external-assets/source-a`。包必须包含 `pack.manifest.json`、`catalog.json` 和 `audit.json`；导入会校验许可证发布状态、路径和 SHA-256，并使用临时目录原子替换。MinIO 部署将 `ASSET_LIBRARY_DIR` 指向挂载目录，项目导入时再写入 MinIO 对象存储。

## 用户如何交付自己的素材

1. 在项目资源入口上传原始文件，保留来源、版本、媒体类型和校验摘要。
2. 等待处理状态为可用后，在二维或三维编辑器插入；实例级材质、颜色和变换不会修改公共原件。
3. 发布体检确认场景只引用存在的资源版本，再生成发布记录。
4. 交付项目时导出场景合同、资源清单、许可证/署名和版本锁定信息；大文件放对象存储或用户自己的发布包，不放 Git 历史。

## 许可与来源

每个可再分发素材包必须随目录保留来源 URL、精确许可证、下载版本、SHA-256 和修改说明。Nature Kit 当前是 CC0，仓库仍保留 Kenney 来源说明；其它模型、字体、图标和图片必须逐项审计后才能进入发行包。第三方供应商 API 返回的模型默认属于用户或供应商约束，不能因为能下载就打进公共镜像。

完整的归属和发布检查见[公开源码发布准备](https://github.com/fatasia/bim-studio/blob/main/docs/OPEN_SOURCE_READINESS.md)与[公共源码发布清单](https://github.com/fatasia/bim-studio/blob/main/docs/open-source-release-checklist.md)。应用内操作见[管理资源并插入 2D / 3D](/docs/resource-workflow)。

## 模板与组件的版本策略

- 模板和组件目录随应用版本发布，使用稳定 ID；删除或改语义时保留迁移说明。
- 模板内的数字只用于演示布局，业务值必须在用户项目中重新绑定，不把示例数据当成真实指标。
- 用户交付包记录应用版本、模板 ID、组件 ID、资源哈希和数据绑定；接收方可在同版本源码或镜像中复现。
- 私有模板可以作为项目级文件或独立扩展交付，不直接修改核心目录；公开后再补许可证和 CI 校验。
