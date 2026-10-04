# `.dgc`(Deep Geometry Clusters)格式规格 v1

> 权威实现:`packages/deep-engine-native/geometry_dag/src/dgc.rs`(`write_dgc` / `read_dgc`)。
> 本文档与实现同步;冲突时以实现 + `tests/dgc_roundtrip` 为准。

## 总览

`.dgc` 是 Nanite M2 离线编译管线的持久化格式:层级簇 DAG 的流式二进制编码。
设计目标:全小端、段 payload 8 字节对齐(可整段映射 typed array)、逐段 CRC32C、
文件尺寸自锁定、保留字段护栏、段级 zlib 可选压缩。

## 字节序与对齐

- 所有多字节标量一律 **小端(LE)**。
- 每段 payload 起始偏移 **8 字节对齐**(文件头 64B 与段头 88B 均为 8 的倍数,天然满足)。
- 填充字节必须为 `0x00`。

## 文件头(64 字节,偏移 0)

| 偏移 | 尺寸 | 字段 | 说明 |
|---:|---:|---|---|
| 0x00 | 4 | `magic` | ASCII `"DGC1"`(`44 47 43 31`) |
| 0x04 | 4 | `version` | `u32 = 1` |
| 0x08 | 4 | `flags` | `u32`;bit0(`0x1`) = 段 payload zlib 压缩(RFC 1950,flate2 level 6);其余位必须为 0 |
| 0x0C | 4 | `level_count` | `u32`,≥1 |
| 0x10 | 4 | `parent_pair_count` | `u32`,必须 == `level_count - 1` |
| 0x14 | 4 | `source_vertex_count` | `u32`,level 0 顶点数 |
| 0x18 | 4 | `source_triangle_count` | `u32`,level 0 三角形数 |
| 0x1C | 4 | `max_vertices` | `u32`,簇顶点上限(≤64) |
| 0x20 | 4 | `max_triangles` | `u32`,簇三角形上限(≤126;DAG 路线缺省 64) |
| 0x24 | 8 | `total_file_size` | `u64`,边界锁定:必须等于实际文件字节数 |
| 0x2C | 20 | `reserved` | 必须全 0,读取即校验 |

## 段头(88 字节 × `section_count`,`section_count = level_count + parent_pair_count`)

紧跟文件头,顺序合同:**全部 level 段在前,全部 parents 段在后**(读取端强制校验)。

| 段头内偏移 | 尺寸 | 字段 | 说明 |
|---:|---:|---|---|
| 0x00 | 4 | `kind` | `u32`;`0` = LEVEL,`1` = PARENTS |
| 0x04 | 4 | `level` | LEVEL:层号;PARENTS:细层号 `k`(连接层 k → k+1) |
| 0x08 | 8 | `error` | `f64`(LE bits);LEVEL 有效,PARENTS 写 `0.0` |
| 0x10 | 32 | `counts[8]` | `u32 × 8`:8 个数组槽的元素个数 |
| 0x30 | 8 | `raw_size` | `u64`:payload 解压后字节数 |
| 0x38 | 8 | `stored_size` | `u64`:payload 存储字节数(未压缩时 == raw_size) |
| 0x40 | 8 | `payload_offset` | `u64`:payload 的绝对文件偏移,8 对齐 |
| 0x48 | 4 | `crc32c` | 对 **raw** payload 的 CRC32C(Castagnoli,iSCSI 反射多项式 `0x1EDC6F41`,初值/终值异或 `0xFFFFFFFF`) |
| 0x4C | 12 | `reserved` | 必须全 0,读取即校验 |

## LEVEL 段 payload(槽位固定顺序)

`raw_size == 4 × Σcounts[0..8]`,读取端强制校验。数组按槽位顺序紧凑拼接,无段内对齐:

| 槽 | 数组 | 元素类型 | 语义 |
|---:|---|---|---|
| 0 | `positions` | `f32 × counts[0]` | 层网格顶点,紧凑 XYZ;`counts[0] % 3 == 0` |
| 1 | `indices` | `u32 × counts[1]` | 层网格三角形索引;`counts[1] % 3 == 0`;全部 `< counts[0]/3` |
| 2 | `descriptors` | `u32 × counts[2]` | 每簇 4 字:`[vertexOffset, vertexCount, triangleOffset, triangleCount]`(元素偏移);`counts[2] % 4 == 0` |
| 3 | `vertexRemap` | `u32 × counts[3]` | 拼接的全局顶点表(簇局部 → 全局) |
| 4 | `localTriangleIndices` | `u32 × counts[4]` | 每三角形 1 字:低 24 位 = 三个 8-bit 局部顶点索引 `a \| b<<8 \| c<<16` |
| 5 | `bounds` | `f32 × counts[5]` | 每簇 16 f32:`sphere[4], aabbMin[3], 0, aabbMax[3], 0, cone[4]`;cone cutoff `-1` = 法向锥剔除禁用 |
| 6 | `sourceTriangles` | `u32 × counts[6]` | 输出三角形 → 源三角形(level 0 序) |
| 7 | `clusterSourceSpans` | `u32 × counts[7]` | 每簇 2 字 `[start,end)`:簇 i 的源三角形段;全表必须是 0 起点的前缀和链,`counts[7]/2 == counts[2]/4`,链终点 == `counts[1]/3` |

层不变量(读取端全部强制):`counts[7]/2 == counts[2]/4 == meshlet_count`;
`counts[5] == 16 × meshlet_count`;`counts[3] == Σ descriptors.vertexCount`;
`counts[4] == counts[1]`。

## PARENTS 段 payload

| 槽 | 数组 | 元素类型 | 语义 |
|---:|---|---|---|
| 0 | `parents` | `u32 × counts[0]` | 细层 k 各簇的父簇索引(在层 k+1 内);`counts[0] == level k 的 meshlet_count`;每值 `< 层 k+1 meshlet_count` 或 `0xFFFFFFFF`(无父哨兵:细簇全部三角形被去重丢弃时出现,渲染语义为"无子级可剔除合并") |

## 压缩

`flags & 1 == 1` 时每个段 payload 独立 zlib 压缩;解压输出必须精确等于
`raw_size`(读取端以 `take(raw_size + 1)` 防解压炸弹,超长即拒)。

## 校验链(读取端 fail-closed 全集)

1. magic / version / flags 白名单;
2. `total_file_size` 与实际尺寸一致;
3. 头与段头 `reserved` 全 0;
4. 段顺序(level 全部在前)与 `parent_pair_count == level_count - 1`;
5. `payload_offset` 8 对齐、不越文件尾;
6. 压缩/未压缩的 stored↔raw 尺寸关系;
7. 逐段 CRC32C;
8. LEVEL 段:`raw_size == 4·Σcounts`、counts 余量与不变量、spans 前缀和链、indices 越界;
9. PARENTS 段:条数 == 细层簇数、父索引范围;
10. level 0 尺寸与文件头 `source_*_count` 一致。

## 版本演进规则

- 新版本必须升 `version`;读端遇到未知 version 拒绝(不猜)。
- 扩展字段一律使用 `reserved` 区并保持旧读者可拒绝(未知 flags 位 → 拒绝)。
- 段类型只允许 0/1;其他值拒绝。
