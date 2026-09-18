# Deep2d 命令细分缓存

Native painter 更新显示列表时复用未变化命令的三角形，并沿用已有顶点增量传输。

## 失效条件

缓存比较完整路径内容、绘制样式、变换、透明度、裁剪路径内容和scaleFactor。资源revision只变而内容相同时可以复用；内容改变但revision未变时仍必须重新细分。每次入口继续完整校验显示列表。

zOrder、hitId和scissor不进入细分键：它们不参与路径三角形生成，当前帧重新写入对应命令元数据。字体/image/atlas准备仍走现有路径。缓存命中恢复路径段数、填充/描边三角形计数及顶点，完整Prepared结果与无缓存实现对照。

## 所有权与预算

一个painter链共享CPU缓存，stage候选通过后继续使用；设备重建从新缓存开始。失败候选可能留下已验证命令的纯缓存条目，但不会修改活动显示列表或GPU缓冲。

默认最多4096个命令、8MiB记账载荷，采用有序LRU索引；命中更新和淘汰不扫描全缓存。记账含顶点、路径动词、标识符和条目结构，未将容器/分配器开销包装成精确进程内存。超限命令仍正常细分，只是不驻留缓存。

统计公开hits/misses/evictions/deletions/entries/payload_bytes，renderer和启动诊断已接入；成功整帧会按当前 path command id 清理删除项，失败候选保留旧缓存。这是累计缓存统计，单次更新应取前后差值。

## 验证方式

- 完整Prepared结果对照：相同内容、重排/命中/scissor、同版本改几何、clip依赖传播、DPI/镜像/非均匀缩放、颜色/透明度/描边/虚线/端帽/连接、非法候选以及两版atlas运行包。
- 预算与LRU测试：容量/载荷超限、命中后淘汰正确、重复命中不增长索引；删除 command id 后孤儿清理与同 id 重加结构 miss。
- GPU测试复用128点改1点夹具：同时检查CPU细分命中计数、顶点传输量、绘制批次和实际像素；保留旧缓冲及失败候选回归。

```powershell
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test deep2d_path_cache
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --release --test deep2d_path_cache benchmark_path_cache_partial_change -- --ignored --nocapture
```

基准使用128条曲线路径，只改1条；预热5组、采样20组、交替运行无缓存/冷缓存/局部更新，计时包括显示列表校验和路径细分，不含ChartIR、atlas或GPU。首次缓存构建的分配与拷贝成本单独报告，不能用暖缓存结果代替首次加载表现。

i9-12900HX / Release同轮结果：

| 方式 | 中位 ms | P95 ms |
| --- | ---: | ---: |
| 无缓存细分 | 13.0562 | 14.2828 |
| 首次缓存构建 | 13.7404 | 15.7270 |
| 缓存已存在、只改1条 | 0.8106 | 0.9991 |

局部准备中位减少约94%，首次缓存构建增加约0.68ms（约5%）。缓存记账载荷1,223,972字节。这是该曲线夹具的CPU阶段结果；首次成本及内存权衡保留为后续优化项，未宣称所有负载不退化或端到端FPS提升。

验证结果：缓存集成6项、容量/LRU2项通过，既有painter7/描边矩阵4/atlas7通过；all-target与仓库门禁通过。RTX4060 Laptop / Vulkan图表GPU12项通过，同一次128点改1点记录path hits127/misses1、CPU上传432字节、GPU复制54,864字节、1批次，像素与全量结果一致。

## 后续

ChartIR数据快照与校验、扁平显示列表拼装、atlas准备仍存在完整处理路径。CPU细分缓存和顶点对照各有独立预算；进一步共享数据及避免重复顶点驻留、端到端性能、设备故障与完整视觉验收继续按原方案推进。
