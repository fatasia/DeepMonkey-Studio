# 缓存行统计与局部校验(P1-04)

日期:2026-09-16 凌晨。接续 [共享行快照](deep2d-chart-rows-snapshot-2026-09-16.md) 之后的性能切片。

## 实现

`chart/rows.rs` 的 `ChartRows` 从 `Arc<Vec<Row>>` 升级为 `Arc<RowsInner>`(`rows` + `Mutex<Option<Arc<RowStats>>>`):

- `RowStats` 一次线性扫描得出:每列 `finite`(所有行该列均为有限数值)与 `positive`(有限且 >0)、`string_over_budget`(任一字符串超 4096 UTF-16 码元)、行宽与空集元数据。查询接口 `column_is_finite(column)` / `column_is_positive(column)` / `string_over_budget`。
- 惰性缓存:首次 `stats()` 扫描并缓存,之后 O(1);快照克隆(Arc 共享)复用同一份 `Arc<RowStats>`。
- 自动失效:`RowsInner` 手动实现 `Clone`(分离克隆不继承统计);`DerefMut` 在 `Arc::make_mut` 后清空统计。唯一可变入口即失效点,不存在绕过路径。
- 语义等价:`semantic_validation.rs` 三处行扫描(字符串预算、heatmap 有限性、数值轴 linear/log)改为统计查询。空数据集保持原 `iter().any()` 为假的通过语义;行宽不足该列等价于原 `row.get(column)=None` 失败;超行预算数据集维持原样不扫描不缓存。
- 维度/轴/系列/标签等非行数据仍逐次校验,不受缓存影响。

## 对照证据(2026-09-16)

行为测试(`tests/chart_rows_snapshot.rs` 新增 3 项,全套 8 通过):

- 缓存命中与共享:验证后 `cached_stats` 存在,克隆快照与源 `Arc::ptr_eq` 同一份;可变访问后本数据集统计为 None,原快照保持且指针不变,后续验证仍通过。
- 直接扫描语义保持:数值列字符串混入在统计路径下同样拒绝,修正后通过。
- 列查询边界:短行缺列、分类文本列、0 与 log 正数、空数据集、超长字符串预算、短文本,全部按原判定。

Release 基准(重复完整源校验,8 数据集×8192 行,25 轮去 5 预热):

- 缓存前基线:median 4.7761ms / P95 7.2712ms(2026-09-16 记录,见剩余任务表)。
- 缓存后热路径:两次独立 release 进程 median 0.279ms / 0.3816ms,P95 0.3006ms / 0.5904ms;约 13~17 倍。首轮冷扫描建缓存,后续轮全部命中。复现:`cargo test --locked --manifest-path packages/deep-engine-native/Cargo.toml --release --test chart_rows_snapshot -- --ignored --nocapture`。

## 边界

- 未实现混合值列式分块(P1-03)与统计的列级局部失效;当前失效粒度是整个数据集的行存储(任何 DerefMut)。
- 基准与 GPU 证据不互推;本切片未重跑 GPU(校验在 CPU 路径,GPU 渲染输入不变)。
