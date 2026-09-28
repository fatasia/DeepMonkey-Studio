/**
 * JT reader 稳定错误码词表(2026-09-27 收尾切片定义)。
 *
 * 纪律:
 *  - `code` 是机器可读契约:消费方(质量门禁、损失登记、测试)只允许依赖 code,
 *    不允许解析 `message`(message 是人读细节,措辞可在不通知的情况下调整)。
 *  - code 一经发布即冻结;新增情形只能新增 code 或复用既有 code,禁止改写语义。
 *  - 每个抛出点必须显式携带 code;缺省 `format-invalid` 仅保留给本包之外
 *    (apps/api)以同一错误类型表达的 JT 语义失败,reader 自身不使用缺省。
 *  - 清单的权威文档在 docs/format-support.md 的 JT 节与
 *    docs/reports/deep-core/T22-implementation.md 收尾小节。
 */
export const JT_ERROR_CODES = [
  /** 缺省码:reader 自身不使用;保留给包外以 JtFormatError 表达的 JT 语义失败。 */
  "format-invalid",
  /** 文件头不含可识别的 JT 版本文本。 */
  "header-unrecognized",
  /** 文件字节超过 JtReadLimits.maxFileBytes。 */
  "file-too-large",
  /** 字节序不受支持:文件头标记非法,或 TopoMesh 译码仅支持小端。 */
  "byte-order-unsupported",
  /** TOC 与数据段自洽性失败:段长度无效、TOC 标识与段标识不一致、声明长度不一致。 */
  "toc-inconsistent",
  /** 段压缩算法标记不受支持(压缩标记 2=Deflate/3=XZ 之外且非未压缩)。 */
  "compression-unsupported",
  /** 压缩流本身解压失败(XZ/Deflate 校验或截断)。 */
  "decompress-failed",
  /** 段载荷长度字段无效(压缩长度越界等)。 */
  "segment-payload-invalid",
  /** TOC 中找不到头声明的 LSG 数据段。 */
  "lsg-segment-missing",
  /** 二进制读取越界:偏移/长度无效或超出缓冲区。 */
  "read-bounds-exceeded",
  /** U64 字段超出 JavaScript 安全整数。 */
  "safe-integer-exceeded",
  /** 数量/深度/工作量/解压输出超过安全上限(JtReadLimits 及各处 MAX_*)。 */
  "limit-exceeded",
  /** 计数不一致:压缩包/数组长度与声明数量或顶点数不一致。 */
  "count-mismatch",
  /** 字段值非法:分量数量、矩阵维度、位宽、非有限数值、负数计数等。 */
  "field-invalid",
  /** U32 内容哈希校验失败(坐标/属性/拓扑复合哈希)。 */
  "hash-mismatch",
  /** 外层与顶点记录的属性绑定掩码不一致。 */
  "binding-mismatch",
  /** 量化参数非法:上限/位数越界、同组位数不一致。 */
  "quantization-invalid",
  /** 均匀量化码超出 2^bits-1 值域(典型损坏输入)。 */
  "quantization-code-out-of-range",
  /** 拓扑重建失败:符号流、槽位、邻接、分裂面等结构约束不满足。 */
  "topology-invalid",
  /** 三角索引越界(索引 ≥ 顶点数)。 */
  "index-out-of-range",
  /** 退化多边形(顶点数 < 3)。 */
  "polygon-degenerate",
  /** 属性编码不受支持:HSV 量化顶点色、附属字段(auxiliary fields)。 */
  "attribute-encoding-unsupported",
  /** TriStrip/TopoMesh 形态或版本不受支持(声明范围外版本、非标准压缩元素)。 */
  "shape-version-unsupported",
  /** Int32CDP/CDP2 CODEC 标识不受支持(仅 1=Null/3=Arithmetic 已验证)。 */
  "codec-unsupported",
  /** 场景图存在环(实例路径循环)。 */
  "graph-cycle",
  /** 场景图引用不存在的节点编号。 */
  "node-reference-missing",
  /** PMI 数据段布局解析失败(计数越界、元素越界、视图块不一致等)。 */
  "pmi-layout-invalid",
] as const;

export type JtErrorCode = (typeof JT_ERROR_CODES)[number];
