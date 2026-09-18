# Deep2d 路径顶点增量传输

Native 更新显示列表时，可以从活动 GPU 缓冲复制未变化的路径顶点，只从 CPU 上传变化部分，保持原有绘制批次和候选提交方式。

## 实现

- 按细分后的命令顶点范围匹配内容。哈希用于查找，CPU 对照字节必须完全相同才允许复制；重排、删除和长度变化不依赖旧顶点偏移。
- 相邻上传范围合并；源和目标都连续的复制范围合并。新缓冲拥有独立存储，旧缓冲只读，候选失败或丢弃不修改旧画面。
- 完整顶点内容命中已有 GPU 缓存时直接复用。否则准备候选缓冲，通过队列写入变化范围和 GPU buffer copy 填充保留范围。
- CPU 对照数据最多8MiB、4096个命令范围，按painter/device epoch持有。预计可复制不足16KiB或需要超过64条copy命令时，使用连续上传；这些是有界的初始传输策略，不代表所有设备的最优阈值。

统计区分 `uploaded_bytes`、`copied_bytes`、`reused_bytes`、传输范围数和 `shadow_bytes`。仅统计路径顶点；atlas上传另走原路径。启动诊断输出该统计，renderer也提供当前候选提交后的读取入口。

## 真实验证

RTX4060 Laptop / Vulkan，128个散点中修改1个：

| 项目 | 字节/数量 |
| --- | ---: |
| 完整路径顶点 | 55,296字节 |
| CPU上传 | 432字节 |
| GPU复制 | 54,864字节 |
| 绘制批次 | 1 |

该夹具CPU路径顶点上传减少99.2%，仍会分配候选GPU缓冲并复制保留顶点；没有端到端帧率或GPU耗时提升结论。

真实测试确认候选像素与全量上传逐字节一致，重排使用零CPU顶点上传，相同内容命中完整缓存，非法候选被拒绝后旧缓冲仍能画出原像素。最终传输测试和既有Deep2d缓存/中文/路径裁剪/DPI六项通过；首轮chart GPU十二项通过。CPU五项覆盖范围重排/增删/变长、合并、哈希碰撞复核、内存与范围预算、连续上传阈值。Native普通bin77项通过、27项显式GPU忽略，all-target检查通过。

```powershell
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --bin deep-engine-native chart_gpu_tests::vertex_transfer -- --ignored --test-threads=1 --nocapture
```

## 后续

后续已加入[命令细分缓存](deep2d-path-cache-2026-09-15.md)，跳过未变化路径的重复细分。ChartIR数据快照、扁平显示列表、atlas顶点仍有完整处理路径。共享数据、资源生命周期预算、全局Epoch、持久顶点分配器、设备故障注入、全链路性能与完整视觉验收继续按原计划推进。
