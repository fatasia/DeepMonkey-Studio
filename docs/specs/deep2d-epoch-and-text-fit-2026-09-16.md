# 全局 Epoch(P1-01)与测量式文字截断(P1-17)

日期:2026-09-16 凌晨。两个切片同夜完成,合并在一份 spec 回填。

## P1-01 全局 Epoch

`chart/epoch.rs`(新,73 行)定义 `ChartEpoch { document_revision, data_revision, layout_revision, resource_set, published }`:

- **同源不复制**:data_revision 由 `current_epoch()` 直读 `ChartRuntime::data_revision()`,禁止第二份计数器;数据更新路径零改动,既有的 CAS 乐观锁失败即零写入,epoch 天然一致。
- **document_revision**:from_package 以 `(package_id, package_hash)` 哈希、from_chart 以 chart id 哈希初始化;同包两次打开相同,换包必异。DefaultHasher 跨进程不保证稳定,仅用于运行期对比(已注释)。
- **事务提交**:`ChartEpochCommit` 打包 candidate chart + 展示列表 + legend 页;可失败步骤(present/stage)在 `new` 前完成,`commit()` 在 GPU publish(不可回滚)之后调用且内部纯赋值——chart/deep2d/epoch 同帧落地,消除「GPU 已 publish 而内容未更新」中间态。`app/chart.rs` 的 `update()` 与 `change_legend_page()` 已改用该事务;legend 页计入 resource_set。
- **published** 仅在 commit 后为真,任何失败路径保持旧值;「present 后才提升」与包级 LKG 范式一致。
- **layout_revision**:本切片只开 `bump_layout()` 入口,`ChartRuntime::resize` 接线留待后续(现状全仓无 resize 调用方)。

验证:`tests/chart_epoch.rs` 7 项(数据成功推进、失败全保持、交互推进、legend 页仅推 resource_set、换包重建、published 仅经 commit、layout bump);经 `#[path]` 并入的 player_content 既有 12 项同跑,19 通过。`cargo check --all-targets` 0 warning。

## P1-17 真实文字测量/省略

- `platform_text/raster.rs` 新增 `measure()`:cosmic-text 自然单行宽度(无视口、不换行),glyph_id==0 缺字同样拒绝。
- `chart/legend_render.rs` 新增 `fit_ellipsis()`:控制字符规范化后,二分最大前缀使「前缀+…」实测宽度 ≤ 可用宽度;O(log n) 次测量,字符数(legend 24/tooltip 64)只是搜索上界。图例图标前缀("✓ "/"○ ")按同字体实测占宽后再分配标签预算。
- `chart/tooltip_render.rs`:按「行」整体实测截断(heading、`label: value` 合并行、「另 N 项」),替代原按字符数截断;窄窗与长中文不再撑破单行版面。
- 验证:`tests/chart_text_fit.rs` 3 项(短文原样/长文测量达标/预算越大保留越多、极小预算降级为省略号+控制字符规范化+预算校验、字符上界约束);chart_tooltip_render 4 项、chart_legend 2 项既有回归通过。

## 边界

- 文字字体为系统已安装字体(real raster 既有事实),字体打包与字体级资源 revision 仍属 P1-19/P1-08。
- Epoch 的 GPU 端到端失败注入未在真实窗口运行(CPU 测试纪律);`package_live` 换包路径天然原子,未改(代理同族排查确认)。
- 已知基线红项(早前并行会话遗留,非本夜引入):`tests/chart_runtime.rs` 一项 selected/hover 语义断言失败,涉事 `runtime.rs`/`emphasis.rs` 修改时间早于本夜会话,留给下一会话归因。
