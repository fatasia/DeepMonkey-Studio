import type { ModelFormat } from "./project.js";

/**
 * 装配结构树与节点属性的 web 消费合同。
 * 服务端从转换 sidecar（hierarchy.json / properties.json）轻量裁剪而来：
 * hierarchy 的 meshIds、装配路径等大数组不进入该载荷，只保留展示所需的计数。
 */
export interface ModelStructureNode {
  id: string;
  name: string;
  /** 生成器写入的节点类别（如"装配""零件""JT 结构模型"）；旧产物可能缺省。 */
  type?: string;
  /** 直接挂在该节点上的几何网格总数。 */
  meshCount: number;
  /** 前 8 个网格 id 的样本，供按需查询属性；完整清单不进入该载荷。 */
  meshSampleIds?: string[];
  childCount: number;
  children: ModelStructureNode[];
}

export interface ModelStructureResponse {
  schemaVersion: 1;
  sourceFormat: ModelFormat;
  sourceName: string;
  nodeCount: number;
  /** 节点数超过服务端上限时停止下钻；越界子树不再展开，true 时界面必须提示截断。 */
  truncated: boolean;
  root: ModelStructureNode;
}

export interface ModelStructurePropertyEntry {
  elementId: string;
  displayProperties: Record<string, string>;
}

/** 按 id 批量查询 properties.json 的结果；未命中的 id 列入 missing，不做静默丢弃。 */
export interface ModelStructurePropertiesResponse {
  schemaVersion: 1;
  elements: Record<string, ModelStructurePropertyEntry>;
  missing: string[];
}
