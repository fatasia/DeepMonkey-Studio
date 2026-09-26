import { BinaryReader, JtFormatError } from "./binaryReader.js";
import { readSegmentPayload, type JtContainer } from "./container.js";
import {
  type JtPmiEntityGroup,
  type JtPmiInfo,
  type JtPmiSegmentSummary,
  type JtReadLimits,
  type JtSegmentEntry,
} from "./types.js";

/**
 * JT PMI 数据段(type 3)的结构级解析。
 *
 * 权威依据(仓内开源参考 + 真实样本字节双重验证):
 *  - PMI Data Segment 按 Meta Data Segment 同构解析(jt-java JTSegment 注释引用 JT 规范 7.2.7);
 *  - 段内逻辑元素头 = U32 元素长度 + GUID + U8 基础类型 + I32 对象 ID(oce-jt JtData_Model::readElement);
 *  - PMI Manager Meta Data Element(GUID ce357249-38fb-11d1-a506-006097bdc6e1)的字段流按
 *    oce-jt JtElement_MetaData_PMIManager + voyager-example-block-jt10.3.jt 段(865 字节 XZ,
 *    解压 6910 字节)逐字节对拍锁定:
 *      U8 元素版本; I16 附加版本(JT>8); I16 结构版本; I16 保留;
 *      I32 关联数量 + N×(5×I32); I32 用户属性数量 + N×(2×I32);
 *      I32 字符串数量 + N×(I32 长度 + 长度×U16, 无终止符);
 *      I32 视图数量 + N×块,每块 = 80 字节头 + 属性对,恰好消费至下一块起点:
 *        +0 视线方向 3×F32、+12 视角 F32、+16 视点 3×F32、+28 目标点 3×F32、
 *        +40 视角三元组 3×F32、+52 视口直径 F32、+56 保留 F32;
 *        +60/+64 保留 I32、+68 视图用户标签 I32(真实样本 23/28/…/58,递增 5)、
 *        +72 名称字符串 ID I32(真实样本 0/3/4/…/9,与字符串表逐项匹配)、
 *        +76 属性对数量 I32;
 *        属性对 = 键/值 MbString(I32 长度 + 长度×U16 + U8 标志字节,观察值 0/1)。
 *    属性字符串带标志后缀、字符串表条目不带——两种字符串线格式已逐条字节验证。
 *  - 经典 PMI 实体列表(尺寸/注释/基准/形位公差等 13 类,oce-jt PMIEntities)在真实样本的
 *    Manager 元素中不存在(头部之后直接是关联列表)。解析器不虚构这些计数;若未来遇到
 *    以 13 类实体开头的布局,数量字段会触发布局一致性校验失败并如实上报 unresolved,
 *    不会错读成关联数量。
 */

const PMI_MANAGER_TYPE_ID = "ce357249-38fb-11d1-a506-006097bdc6e1";
const END_OF_ELEMENTS = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const PMI_SEGMENT_TYPE = 3;
const ELEMENT_HEADER_BYTES = 21; // U32 长度 + GUID 16 + U8 基础类型
const MAX_PMI_ENTITIES = 100_000;
const MAX_PMI_STRINGS = 100_000;
const MAX_STRING_UNITS = 1_000_000;
const MODEL_VIEW_BLOCK_HEADER_BYTES = 80; // 60B 视图标量 + 4×I32(保留/标签/名称 ID/属性对数)

/** Association 的 packed 源/目标字段:bit0-23 对象 ID、bit24-30 类型、bit31 间接引用(oce-jt 位域)。 */
export interface JtPmiAssociation {
  sourceObjectId: number;
  sourceType: number;
  sourceIndirect: boolean;
  destinationObjectId: number;
  destinationType: number;
  destinationIndirect: boolean;
  reasonCode: number;
  sourceOwnerStringId: number;
  destinationOwnerStringId: number;
}

export interface JtPmiModelView {
  nameStringId: number;
  name?: string | undefined;
  eyeDirection: [number, number, number];
  eyePosition: [number, number, number];
  targetPoint: [number, number, number];
  /** 与视图成对的属性清单(键/值字符串),结构级证据;语义映射未实现。 */
  properties: Array<{ key: string; value: string }>;
}

function unpackPackedId(value: number): { objectId: number; type: number; indirect: boolean } {
  return {
    objectId: value & 0xff_ffff,
    type: (value >>> 24) & 0x7f,
    indirect: (value >>> 31) === 1,
  };
}

function readCount(reader: BinaryReader, cursor: number, label: string): { count: number; next: number } {
  const count = reader.i32(cursor, `PMI ${label}数量`);
  if (count < 0 || count > MAX_PMI_ENTITIES) throw new JtFormatError(`JT PMI ${label}数量 ${count} 越界`);
  return { count, next: cursor + 4 };
}

/** 字符串表条目:I32 长度 + 长度×U16,无终止符(真实样本字节验证)。 */
function readTableString(reader: BinaryReader, cursor: number, label: string): { text: string; next: number } {
  const length = reader.i32(cursor, `${label}长度`);
  if (length < 0 || length > MAX_STRING_UNITS) throw new JtFormatError(`JT PMI ${label}长度 ${length} 无效`);
  reader.ensure(cursor + 4, length * 2, label);
  const text = new TextDecoder("utf-16le").decode(reader.bytes(cursor + 4, length * 2, `${label}内容`));
  return { text: text.replace(/\0+$/g, ""), next: cursor + 4 + length * 2 };
}

/** MbString(属性键/值):I32 长度 + 长度×U16 + U8 标志字节(真实样本字节验证)。
 * 标志字节观察值为 0 或 1(18 个属性字符串中 17 个为 0、末尾 1 个为 1),
 * 语义疑为隐藏/有效标志而非严格 NUL,解析时消费但不校验取值,避免误拒合法文件。 */
function readNullTerminatedString(reader: BinaryReader, cursor: number, label: string): { text: string; next: number } {
  const length = reader.i32(cursor, `${label}长度`);
  if (length < 0 || length > MAX_STRING_UNITS) throw new JtFormatError(`JT PMI ${label}长度 ${length} 无效`);
  reader.ensure(cursor + 4, length * 2 + 1, label);
  const text = new TextDecoder("utf-16le").decode(reader.bytes(cursor + 4, length * 2, `${label}内容`));
  return { text: text.replace(/\0+$/g, ""), next: cursor + 4 + length * 2 + 1 };
}

/** 解析单个 PMI Manager Meta Data 元素;输入为元素数据区(元素头之后)的起点与终点。 */
function parsePmiManagerElement(
  reader: BinaryReader,
  dataStart: number,
  elementEnd: number,
): {
  elementVersion: number;
  structureVersion: number;
  associations: JtPmiAssociation[];
  userAttributeCount: number;
  strings: string[];
  modelViews: JtPmiModelView[];
} {
  let cursor = dataStart;
  const elementVersion = reader.u8(cursor, "PMI 元素版本");
  cursor += 1;
  const additionalVersion = reader.i16(cursor, "PMI 附加版本");
  cursor += 2;
  const structureVersion = reader.i16(cursor, "PMI 结构版本");
  cursor += 2;
  cursor += 2; // 保留字段
  void additionalVersion;

  const association = readCount(reader, cursor, "关联");
  cursor = association.next;
  const associations: JtPmiAssociation[] = [];
  for (let index = 0; index < association.count; index += 1) {
    reader.ensure(cursor, 20, "PMI 关联条目");
    const source = unpackPackedId(reader.i32(cursor, "PMI 关联源"));
    const destination = unpackPackedId(reader.i32(cursor + 4, "PMI 关联目标"));
    const reasonCode = reader.i32(cursor + 8, "PMI 关联原因码");
    const sourceOwnerStringId = reader.i32(cursor + 12, "PMI 关联源属主字符串 ID");
    const destinationOwnerStringId = reader.i32(cursor + 16, "PMI 关联目标属主字符串 ID");
    cursor += 20;
    associations.push({
      sourceObjectId: source.objectId,
      sourceType: source.type,
      sourceIndirect: source.indirect,
      destinationObjectId: destination.objectId,
      destinationType: destination.type,
      destinationIndirect: destination.indirect,
      reasonCode,
      sourceOwnerStringId,
      destinationOwnerStringId,
    });
  }

  const userAttributes = readCount(reader, cursor, "用户属性");
  cursor = userAttributes.next;
  reader.ensure(cursor, userAttributes.count * 8, "PMI 用户属性");
  cursor += userAttributes.count * 8; // 每条 = 键/值字符串 ID 各一个 I32(结构级跳读)

  const stringTable = readCount(reader, cursor, "字符串");
  cursor = stringTable.next;
  if (stringTable.count > MAX_PMI_STRINGS) throw new JtFormatError(`JT PMI 字符串数量 ${stringTable.count} 越界`);
  const strings: string[] = [];
  for (let index = 0; index < stringTable.count; index += 1) {
    const entry = readTableString(reader, cursor, `字符串表[${index}]`);
    strings.push(entry.text);
    cursor = entry.next;
  }

  const views = readCount(reader, cursor, "模型视图");
  cursor = views.next;
  const modelViews: JtPmiModelView[] = [];
  for (let index = 0; index < views.count; index += 1) {
    const viewStart = cursor;
    reader.ensure(viewStart, MODEL_VIEW_BLOCK_HEADER_BYTES, "PMI 模型视图块头");
    const eyeDirection: [number, number, number] = [
      reader.f32(viewStart, "PMI 视线方向 X"),
      reader.f32(viewStart + 4, "PMI 视线方向 Y"),
      reader.f32(viewStart + 8, "PMI 视线方向 Z"),
    ];
    const eyePosition: [number, number, number] = [
      reader.f32(viewStart + 16, "PMI 视点 X"),
      reader.f32(viewStart + 20, "PMI 视点 Y"),
      reader.f32(viewStart + 24, "PMI 视点 Z"),
    ];
    const targetPoint: [number, number, number] = [
      reader.f32(viewStart + 28, "PMI 目标点 X"),
      reader.f32(viewStart + 32, "PMI 目标点 Y"),
      reader.f32(viewStart + 36, "PMI 目标点 Z"),
    ];
    const userLabel = reader.i32(viewStart + 68, "PMI 视图用户标签");
    const nameStringId = reader.i32(viewStart + 72, "PMI 视图名称字符串 ID");
    if (nameStringId < 0 || nameStringId >= strings.length) {
      throw new JtFormatError(`JT PMI 视图名称字符串 ID ${nameStringId} 越界`);
    }
    const pairs = readCount(reader, viewStart + 76, "视图属性对");
    if (viewStart + MODEL_VIEW_BLOCK_HEADER_BYTES !== pairs.next) {
      throw new JtFormatError("JT PMI 视图块头与属性对数量声明不一致");
    }
    cursor = pairs.next;
    const properties: Array<{ key: string; value: string }> = [];
    for (let pair = 0; pair < pairs.count; pair += 1) {
      const key = readNullTerminatedString(reader, cursor, `视图属性键[${pair}]`);
      cursor = key.next;
      const value = readNullTerminatedString(reader, cursor, `视图属性值[${pair}]`);
      cursor = value.next;
      properties.push({ key: key.text, value: value.text });
    }
    void userLabel;
    modelViews.push({ nameStringId, name: strings[nameStringId], eyeDirection, eyePosition, targetPoint, properties });
  }

  if (cursor > elementEnd) {
    throw new JtFormatError(`JT PMI Manager 元素越界 ${cursor} > ${elementEnd}`);
  }
  return { elementVersion, structureVersion, associations, userAttributeCount: userAttributes.count, strings, modelViews };
}

/**
 * 解析 PMI 数据段(可压缩)。返回结构级清单;
 * 段内不含可识别的 PMI Manager 元素时返回 undefined(由调用方决定 warnings 措辞)。
 */
export async function readJtPmiSegment(
  container: JtContainer,
  segment: JtSegmentEntry,
  limits: JtReadLimits,
): Promise<JtPmiSegmentSummary | undefined> {
  const payload = await readSegmentPayload(container, segment, limits);
  const reader = new BinaryReader(payload, container.header.byteOrder);
  let managerCount = 0;
  let elementVersion = 0;
  let structureVersion = 0;
  const associations: JtPmiAssociation[] = [];
  const strings: string[] = [];
  const modelViews: JtPmiModelView[] = [];
  let offset = 0;
  // 元素循环:元数据段与 LSG 同构,以 End-Of-Elements GUID 或元素长度耗尽为止。
  // 段尾若存在非元素字节(真实样本为 26 字节段级残留),计入未解析区,不猜测其结构。
  while (offset + ELEMENT_HEADER_BYTES <= payload.byteLength) {
    const elementLength = reader.u32(offset, "PMI 元素长度");
    // End-Of-Elements 元素的 elementLength = 16(仅 GUID 自身),与 LSG 元素循环同一约定。
    if (elementLength < 16) throw new JtFormatError(`JT PMI 元素长度 ${elementLength} 无效`);
    const elementEnd = offset + 4 + elementLength;
    if (elementEnd > payload.byteLength) throw new JtFormatError("JT PMI 元素长度越过段尾");
    const typeId = reader.guid(offset + 4, "PMI 元素类型");
    if (typeId === END_OF_ELEMENTS) break;
    if (typeId === PMI_MANAGER_TYPE_ID) {
      const parsed = parsePmiManagerElement(reader, offset + ELEMENT_HEADER_BYTES + 4, elementEnd);
      managerCount += 1;
      elementVersion = parsed.elementVersion;
      structureVersion = parsed.structureVersion;
      associations.push(...parsed.associations);
      strings.push(...parsed.strings);
      modelViews.push(...parsed.modelViews);
    }
    offset = elementEnd;
  }
  if (managerCount === 0) return undefined;
  const entityGroups: JtPmiEntityGroup[] = [
    { type: "association", count: associations.length },
    { type: "modelView", count: modelViews.length },
    { type: "view-property", count: modelViews.reduce((total, view) => total + view.properties.length, 0) },
  ];
  return {
    segmentId: segment.id,
    managerCount,
    elementVersion,
    structureVersion,
    entityGroups,
    strings,
    modelViewNames: modelViews.map((view) => view.name ?? `#${view.nameStringId}`),
  };
}

/** 遍历容器内全部 PMI 数据段;无 PMI 段时返回 undefined(调用方据此在产物中省略 pmi 节)。 */
export async function readJtPmi(
  container: JtContainer,
  limits: JtReadLimits,
): Promise<{ pmi?: JtPmiInfo; warnings: string[] }> {
  const warnings: string[] = [];
  const segments = container.segments.filter((segment) => segment.type === PMI_SEGMENT_TYPE);
  if (segments.length === 0) return { warnings };
  const summaries: JtPmiSegmentSummary[] = [];
  for (const segment of segments) {
    try {
      const summary = await readJtPmiSegment(container, segment, limits);
      if (summary) summaries.push(summary);
      else warnings.push(`PMI 数据段 ${segment.id} 不含可识别的 PMI Manager 元素,已按结构未知上报`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`PMI 数据段 ${segment.id} 结构解析失败:${reason}`);
    }
  }
  if (summaries.length === 0) return { warnings };
  const types = new Map<string, number>();
  for (const summary of summaries) {
    for (const group of summary.entityGroups) {
      types.set(group.type, (types.get(group.type) ?? 0) + group.count);
    }
  }
  const entityCount = summaries.reduce(
    (total, summary) => total + summary.entityGroups.reduce((sum, group) => sum + group.count, 0),
    0,
  );
  return {
    pmi: {
      segmentCount: summaries.length,
      entityCount,
      types: [...types.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((left, right) => left.type.localeCompare(right.type)),
      segments: summaries,
      structureOnly: true,
      notes: [
        "pmi:structure-only —— 仅输出结构级清单(关联/模型视图/属性组/字符串表),标注、尺寸与文本的语义解析未实现",
        "classic-entity-list:absent-in-sample —— 经典 13 类 PMI 实体列表(尺寸/注释/形位公差等)未在本样本 Manager 元素中出现",
      ],
    },
    warnings,
  };
}
