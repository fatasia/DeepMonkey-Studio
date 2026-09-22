# 冻结字体批量生产（2026-09-18）

发布编译复用现有 cosmic-text 0.19、冻结字体和像素回执，不引入第二套文字引擎。

## 实现依据

[cosmic-text 官方文档](https://docs.rs/cosmic-text/0.19.0/cosmic_text/)建议复用 FontSystem 与 SwashCache；[FreeType FTC](https://freetype.org/freetype2/docs/reference/ft2-cache_subsystem.html)以有界 Face/Size/字形缓存控制反复加载与内存。这里沿用前者实际实现，参考后者的预算纪律，没有新增 FreeType 依赖。

`--rasterize-text-batch` 对相同冻结字体/locale 的请求只解析、建库一次；复用 SHA-256 共享前缀状态，但每项输出的 sourceSha256 仍等于原单项请求完整字节的哈希。逐项校验像素、尺寸、真实字体 face/weight/style、布局行和来源身份。整组结果通过后才进入既有有界像素缓存。

- 每组最多 512 项；请求文件 90 MiB、冻结字体 64 MiB、合计输出像素 64 MiB、结果文件 128 MiB。
- 字体组串行执行；相同字体字节在组内共用，不按每条请求保留一份字库。
- Glyph cache 保留当前请求仍使用的 glyph，清除无关 glyph；沿用 64 MiB 栅格工作上限，不建立无界全局缓存。
- 取消、超时均结束子进程并等其关闭后清理私有文件；失败不覆盖先前产物。真实字体单项/批量全回执等价、缓存复用、中文/双向文本等 25 项 Native 测试通过；批量子进程错序/缺项/像素篡改/超时/取消等 7 项通过；旧单项子进程 23 项回归通过。

## 实测

`test-output/dashboard-text-batch-benchmark-20260918/evidence.json` 固定同一 EXE 和同一冻结 Noto CJK 字库，每轮 6 条中文请求，无宿主像素缓存。所有像素和来源/字体回执逐项全等。

| 轮次 | 逐项进程 | 同字体批量 |
|---|---:|---:|
| 1 | 29.057 s | 5.140 s |
| 2 | 19.843 s | 4.539 s |

这是 CPU 文本生产耗时，不是完整发布耗时。完整 R11 HTTP 候选精确计时 109.246 s，保留 180 s 正式门槛；R10 旧轮从部署文件创建至候选落盘约 156 s，未记录相同计时起点，不能据此报告严格发布加速比例。R11 与 R10 的 91 张 atlas 字节全等，8 次真实窗口筛选通过。

输入至 present 的延迟属于独立运行时性能项，本优化不声称将该项降至 100 ms。
