# P1-19 字体身份与能力矩阵(2026-09-16)

承接 [Deep2D 剩余任务总表](deep2d-remaining-tasks-2026-09-16.md) P1-19:
「冻结字体身份/版本/许可/子集和资源 hash,离线一致;缺字、不可再分发和回退明确对象级诊断。
当前系统微软雅黑栅格化不代表字体已打包。」

## 要解决的真问题

`TextRasterizer::new()` 走 `cosmic_text::FontSystem::new()`,从**操作系统已安装字体**加载。
后果:同一段中文在不同机器上可能用不同字体渲染,而产物里**没有任何记录**——
「本机能显示」被当成了「已支持」。

P1-19 把字体从「运行时恰好装了什么」变成**可冻结、可审计的身份**。

## 交付范围

`src/platform_text/font_capability.rs`:

- `FontFaceIdentity`:家族 / PostScript 名 / 字重 / 斜体 / 等宽 + **字体数据 FNV-1a 64 位 hash**
  与字节数。hash 经 `fontdb::Database::with_face_data` 取自字体原始字节。
- `FontCapabilityReport`:按 hash 稳定排序的全部面 + 来源计数 + 可交付面数。
- `capability_report(&mut FontSystem)`、`family_exists`、`text_shapes_without_missing_glyphs`。
- 经 `TextRasterizer::font_capability()` / `family_exists()` 暴露给产品路径。

## 关键设计决定

**hash 是唯一可信身份,不是家族名。** 同名不同版本、不同厂商的同名字体很常见;
家族名相同不代表文件相同。因此矩阵按 `content_hash` 稳定排序并去重——这与
P1-18 文本 IR 的「标识而非内联属性」是同一思路:**把可比对的量固定下来**。

**用 FNV-1a 而不是 `DefaultHasher`。** 后者跨进程不保证稳定(随机种子),
不能用于冻结身份。FNV-1a 跨机器、跨进程逐字节可复算。

**保守默认:h=能渲染 ≠ 可交付。** 系统字体的再分发权未确认,因此
`usable_in_artifact = false`、`license = Unknown`。任何把它改成 `true` 的改动
必须先解决许可问题——这一点有测试锁定。

**对象级诊断区分两种阻断。** `family_blocked_reason` 对「机器没装」与
「装了但不能发」返回不同原因,使上层能把「补装字体」与「换许可字体」分开处理。

**刻意不做**:不下载、不内嵌字体、不改许可证。真正内嵌(含许可与子集化)是独立决策,
需要用户对再分发权的确认。本模块只做「测量与声明」。

## 实测发现的语义陷阱(已固化为测试)

初版用 cosmic-text 的**成形结果**判断「指定家族是否覆盖」,测试立刻失败:
请求一个**不存在**的家族时,整形器**静默 fallback** 到别的已装字体,照样成形成功,
探针恒返回 `true` 而完全失去意义。

修正为两个口径分离:
- `family_exists`:直接查字体库的面是否存在——**家族可用性的正确判据**;
- `text_shapes_without_missing_glyphs`:回答「按系统整体字体能力,这段文字能否成形
  而不出现 `.notdef`」——**不能**用来证明指定家族覆盖。

`shaping_probe_cannot_prove_family_coverage_because_of_fallback` 这条测试把这个陷阱
固化下来,防止后来者误用。

## 产品接线

`app.rs` 在渲染器就绪后探测一次并打印摘要与代表性面(hash/字节数):

```
native font capability: faces=N system=N embedded=0 usable=0
native font face: family=... postscript=... weight=400 italic=false mono=false hash=... bytes=...
```

**探测只在图表内容存在时执行**:一次全库遍历实测约 9ms,不放进无文本场景的启动路径。

## 验证

`font_capability_tests.rs` 8 项。刻意断言**不变量**而不是具体字体名——
否则换机器时测试会因无关原因失败:

| 测试 | 锁定 |
| --- | --- |
| `capability_report_is_deterministic_across_probes` | 两次探测逐值相同(排序稳定) |
| `faces_are_sorted_by_content_hash_and_unique` | 排序不变量 + hash 去重 |
| `every_face_carries_a_real_content_hash` | 无 `hash=0` 的伪身份;字重在界 |
| `system_fonts_are_measured_but_not_usable_in_an_artifact` | **保守默认**(核心产品语义) |
| `blocked_families_report_distinct_object_level_reasons` | 缺失 vs 许可阻断可区分 |
| `family_exists_rejects_absent_and_out_of_bounds_families` | 存在性探针正确且有正向对照 |
| `shaping_probe_cannot_prove_family_coverage_because_of_fallback` | **fallback 陷阱**固化 |
| `summary_reflects_the_real_counts` | 摘要不漏报不可交付状态 |

## 诚实边界

- **未内嵌任何字体**,因此当前 `usable=0` 是如实反映,不是缺陷。
- **无子集化**:内嵌字体必须先解决许可与子集,另属独立决策。
- **未做跨机器实际比对**:hash 的可复算性由算法保证,但没有第二台机器的实测样本。
- 缺字诊断只覆盖「家族存在性」与「系统整体成形」;具体字符级覆盖矩阵
  (逐 codepoint 的 `cmap` 查询)未做。
- 未接产品渲染决策:矩阵目前只进启动报告,尚无「按能力报告阻断发布」的消费方。