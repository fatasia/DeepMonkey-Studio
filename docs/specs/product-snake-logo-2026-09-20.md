# 全局图形 Logo 替换

用户最终选定上传的青绿色渐变折带 S 形蛇标，覆盖较早的扁平第三款选择。按参考轮廓重绘为路径与渐变构成的 SVG。标志本体不含中英文名称，不改产品名称、主题强调色及客户自定义品牌。

## 开工核对

已读取恢复总账、2026-09-20 主线交接、客户端品牌规格、最近提交和工作树。现有 `DEFAULT_PRODUCT_BRANDING` 将 Web 各入口集中到两个 SVG；Tauri、NSIS、WiX、Native build.rs 共用桌面 icons。品牌资源无在途改动；`check-product-brand.mjs` 已有 Native 嵌入检查，本轮保留。

| 状态 | 入口与证据 | 本轮验收缺口 |
|---|---|---|
| 已完成 | 用户最终上传渐变折带蛇标；Web/桌面/Native 品牌引用已接线 | 复用现有引用，不重建品牌服务 |
| 本轮待办 | public/brand、src-tauri/icons、品牌门禁 | 统一 SVG/PNG/ICO/ICNS、纯图形布局、两轮双主题实图 |
| 明确排除 | 客户上传图标与既有发布 hash | 不覆盖客户品牌、不改写历史发布包 |
| 项目级后验收 | 主线总账已有 FINAL-GATE | 本次 Logo 检查不代替主线整体验收 |

新增文件：本规格、`scripts/generate-product-brand.mjs`、专项验收报告。源 SVG 是唯一图形来源；生成器覆盖兼容 PNG、桌面尺寸、六尺寸 ICO 与 ICNS，并支持 `--check` 检查派生件漂移。

设计对标以用户选定稿为准，界面遵循 design-taste-digitaltwin 的西门子式克制与既有 base.css 令牌。SVG 的固定青绿配色为本轮用户指定的品牌图形颜色，不作为 UI 强调色写入样式。

运行 `node scripts/generate-product-brand.mjs` 更新资源，`node scripts/generate-product-brand.mjs --check` 复验。新构建会嵌入新图标；Native 打包在已验证候选副本中补入当前默认图标，显式客户图标优先。已导出的安装包和发布包不被追溯修改。

验收已完成，具体检查及非本轮全量失败见 [验收报告](../reports/product-snake-logo-2026-09-20.md)。
