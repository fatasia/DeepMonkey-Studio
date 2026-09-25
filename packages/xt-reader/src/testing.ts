import { decodeLatin1 } from "./tokens.js";

/**
 * 合成 X_T 文本夹具：生成能通过固定头校验的最小传输文件。
 * 只用于测试；记录 token 串由调用方按公开格式布局拼接。
 */
export interface SyntheticXtSpec {
  schema: string;
  modellerVersion?: string;
  application?: string;
  /** 标识行 schema；缺省与 header schema 相同。 */
  identificationSchema?: string;
  /** 记录流文本（token 以空白分隔，可含换行模拟折行）。 */
  records: string;
}

const HEADER_LINE_1 = `**ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz${"*".repeat(26)}`;
const HEADER_LINE_2 = `**PARASOLID !"#$%&'()*+,-./:;<=>?[\\]^_\`{|}~0123456789${"*".repeat(22)}`;

export function buildSyntheticXtText(spec: SyntheticXtSpec): Uint8Array {
  const identification = spec.identificationSchema ?? `${spec.schema}_1300`;
  // 记录行以“空格+折行”衔接，模拟真实写入口径：折行去除后 token 边界不合并。
  const records = spec.records.replace(/\r?\n/g, " \n");
  const text = [
    HEADER_LINE_1,
    HEADER_LINE_2,
    "**PART1;",
    "MC=AMD64;",
    "OS=Windows_NT;",
    `FRU=${spec.modellerVersion ?? "Synthetic Fixture Modeller 0.0"};`,
    `APPL=${spec.application ?? "xt-reader-tests"};`,
    "FORMAT=text;",
    "GUISE=transmit;",
    "KEY=synthetic;",
    "FILE=synthetic.x_t;",
    "**PART2;",
    `SCH=${spec.schema};`,
    "USFLD_SIZE=0;",
    "**PART3;",
    `**END_OF_HEADER${"*".repeat(64)}`,
    `T51 : TRANSMIT FILE created by modeller version ${spec.modellerVersion ?? "000000000"} ${identification}`,
    records,
    "",
  ].join("\n");
  return new TextEncoder().encode(text);
}

export function decodeSynthetic(bytes: Uint8Array): string {
  return decodeLatin1(bytes);
}
