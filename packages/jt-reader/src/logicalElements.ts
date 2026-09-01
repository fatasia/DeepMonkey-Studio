import { BinaryReader, JtFormatError } from "./binaryReader.js";
import type { JtByteOrder, JtLogicalElement, JtReadLimits } from "./types.js";

const END_OF_ELEMENTS = "ffffffff-ffff-ffff-ffff-ffffffffffff";

export interface LogicalElementSections {
  sceneElements: JtLogicalElement[];
  propertyAtoms: JtLogicalElement[];
  propertyTableOffset: number;
}

export function readLogicalElementSections(
  bytes: Uint8Array,
  byteOrder: JtByteOrder,
  limits: JtReadLimits,
): LogicalElementSections {
  const reader = new BinaryReader(bytes, byteOrder);
  const sceneElements: JtLogicalElement[] = [];
  const propertyAtoms: JtLogicalElement[] = [];
  let section = 0;
  let offset = 0;
  let elementCount = 0;

  while (offset < reader.length && section < 2) {
    reader.ensure(offset, 20, "逻辑元素头");
    const elementLength = reader.u32(offset, "逻辑元素长度");
    if (elementLength < 16) throw new JtFormatError(`逻辑元素长度 ${elementLength} 无效`);
    const totalLength = elementLength + 4;
    reader.ensure(offset, totalLength, "逻辑元素");
    const objectTypeId = reader.guid(offset + 4, "逻辑元素类型");
    if (objectTypeId === END_OF_ELEMENTS) {
      section += 1;
      offset += totalLength;
      continue;
    }
    if (elementLength < 25) throw new JtFormatError(`逻辑元素 ${objectTypeId} 缺少基础头`);
    elementCount += 1;
    if (elementCount > limits.maxLogicalElements) throw new JtFormatError("JT 逻辑元素数量超过安全上限");
    const element: JtLogicalElement = {
      objectId: reader.i32(offset + 21, "逻辑元素对象 ID"),
      objectTypeId,
      baseType: reader.u8(offset + 20, "逻辑元素基础类型"),
      payload: reader.bytes(offset + 25, elementLength - 21, "逻辑元素内容"),
      streamOffset: offset,
    };
    (section === 0 ? sceneElements : propertyAtoms).push(element);
    offset += totalLength;
  }
  if (section < 2) throw new JtFormatError("JT LSG 未包含完整的逻辑元素结束标记");
  return { sceneElements, propertyAtoms, propertyTableOffset: offset };
}
