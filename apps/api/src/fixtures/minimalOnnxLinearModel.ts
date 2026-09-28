/**
 * 手工编码的最小 ONNX 模型:y = w·x + b(x float32[N] → y float32[1],opset 17)。
 * 用于 T32 网关的真实加载/执行测试:不是注入的假会话,而是真实 onnxruntime 会话
 * 承载的确定性合成模型。工业级模型仍以批准清单制品为准;本夹具只保证图结构真实。
 */

const ELEMENT_TYPE_FLOAT = 1;
const OPSET_VERSION = 17;
const IR_VERSION = 9;

export interface MinimalLinearModelOptions {
  featureCount?: number;
  weights?: number[];
  bias?: number;
}

type WireValue = string | Uint8Array;

function varint(value: number): number[] {
  const bytes: number[] = [];
  let current = BigInt(Math.trunc(value));
  do {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    if (current > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (current > 0n);
  return bytes;
}

function encodeField(fieldNumber: number, wireType: number, payload: WireValue | number[]): number[] {
  const key = varint((fieldNumber << 3) | wireType);
  if (typeof payload === "string") {
    const bytes = Array.from(new TextEncoder().encode(payload));
    return [...key, ...varint(bytes.length), ...bytes];
  }
  if (payload instanceof Uint8Array) {
    return [...key, ...varint(payload.length), ...Array.from(payload)];
  }
  return [...key, ...varint(payload.length), ...payload];
}

function fieldVarint(fieldNumber: number, value: number): number[] {
  return [...varint((fieldNumber << 3) | 0), ...varint(value)];
}

function floatBytes(values: number[]): number[] {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return Array.from(new Uint8Array(view.buffer));
}

function tensorInitializer(name: string, dims: number[], values: number[]): number[] {
  const dimsPacked = encodeField(1, 2, dims.flatMap((dim) => varint(dim)));
  const dataType = fieldVarint(2, ELEMENT_TYPE_FLOAT);
  const nameField = encodeField(8, 2, name);
  const rawData = encodeField(9, 2, floatBytes(values));
  return [...dimsPacked, ...dataType, ...nameField, ...rawData];
}

function valueInfo(name: string, shape: number[]): number[] {
  const dims = shape.flatMap((dim) => encodeField(1, 2, fieldVarint(1, dim)));
  const shapeProto = encodeField(1, 2, dims);
  const tensor = [...fieldVarint(1, ELEMENT_TYPE_FLOAT), ...encodeField(2, 2, shapeProto)];
  // TypeProto.tensor_type 是 TypeProto 的字段 1,这里再包一层。
  const typeProto = encodeField(1, 2, tensor);
  return [...encodeField(1, 2, name), ...encodeField(2, 2, typeProto)];
}

function node(opType: string, inputs: string[], outputs: string[], name: string): number[] {
  return [
    ...inputs.flatMap((input) => encodeField(1, 2, input)),
    ...outputs.flatMap((output) => encodeField(2, 2, output)),
    ...encodeField(3, 2, name),
    ...encodeField(4, 2, opType),
  ];
}

/** 生成 y = w·x + b 的完整 ONNX ModelProto 字节(x [N] float32,MatMul 点积后加偏置)。 */
export function minimalOnnxLinearModel(options: MinimalLinearModelOptions = {}): Uint8Array {
  const featureCount = options.featureCount ?? 3;
  const weights = options.weights ?? [0.7, 0.2, 0.1];
  const bias = options.bias ?? 0;
  if (!Number.isSafeInteger(featureCount) || featureCount <= 0) throw new Error("featureCount 必须为正整数");
  if (weights.length !== featureCount || !weights.every((weight) => Number.isFinite(weight))) {
    throw new Error("权重数量或数值与 featureCount 不一致");
  }
  if (!Number.isFinite(bias)) throw new Error("偏置必须为有限数值");

  const opset = encodeField(8, 2, [...encodeField(1, 2, ""), ...fieldVarint(2, OPSET_VERSION)]);
  const graph = encodeField(7, 2, [
    ...encodeField(1, 2, node("MatMul", ["x", "w"], ["dot"], "t32-dot")),
    ...encodeField(1, 2, node("Add", ["dot", "b"], ["y"], "t32-bias")),
    ...encodeField(2, 2, "t32-minimal-linear-forecast"),
    ...encodeField(5, 2, tensorInitializer("w", [featureCount], weights)),
    ...encodeField(5, 2, tensorInitializer("b", [1], [bias])),
    ...encodeField(11, 2, valueInfo("x", [featureCount])),
    ...encodeField(12, 2, valueInfo("y", [1])),
  ]);
  const model = [...fieldVarint(1, IR_VERSION), ...opset, ...graph];
  return Uint8Array.from(model);
}
