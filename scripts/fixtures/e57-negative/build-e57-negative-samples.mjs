import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultPositive = path.join(repositoryRoot,
  "data/external-assets/industrial-format-plan/samples/extracted/libE57Format-test-data/self/ColouredCubeDouble.e57");
const defaultOut = path.join(repositoryRoot,
  "data/external-assets/industrial-format-plan/samples/self-made-negative");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// CRC-32C(Castagnoli,反射形式 0x82F63B78,init/xorOut 0xFFFFFFFF),与 libE57Format
// CheckedFile 的页校验参数一致:每 1024B 物理页 = 1020B 数据 + 页尾 4B 小端 CRC。
const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0x82F63B78 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();
function crc32c(bytes) {
  let value = 0xFFFFFFFF;
  for (const byte of bytes) value = CRC32C_TABLE[(value ^ byte) & 0xFF] ^ (value >>> 8);
  return (value ^ 0xFFFFFFFF) >>> 0;
}
/** 头部补丁会破坏所在物理页的页尾 CRC;重算之,使拒绝点落在签名/版本/长度校验而非页校验。
 *  libE57Format 在 CRCPP 标准值后 swap_uint32 再与小端解释比较,等价于页尾按大端存标准 CRC-32C。 */
function patchHeaderPage(bytes, offset, replacement) {
  const copy = Buffer.from(bytes);
  replacement.copy(copy, offset);
  const checksum = crc32c(copy.subarray(0, 1020));
  copy.writeUInt32BE(checksum, 1020);
  return copy;
}

/**
 * 自造 E57 负样本(确定性派生,无网络、无第三方工具)。
 * 派生基准是上游 CC0 测试集里的合法正例;每次派生只改动一处,
 * 使每个负样本恰好命中解析管线的一个明确拒绝点。
 * 文件头布局(ASTM E57 Table 1):signature 8B、majorVersion u32@8、
 * minorVersion u32@12、filePhysicalLength u64@16;正文按 1024B 物理页存储,
 * 每页尾带 CRC32C(libE57Format CheckedFile)。
 */
function deriveNegativeSamples(positive) {
  return [
    {
      name: "selfmade-bad-magic.e57",
      fault: "bad-magic",
      derivation: "将偏移 0 的 8 字节签名 'ASTM-E57' 改写为 'XSTM-E57' 并重算第 0 页 CRC,其余字节不变",
      expected: "E57-rejected ... ErrorBadFileSignature",
      bytes: patchHeaderPage(positive, 0, Buffer.from("XSTM-E57", "ascii")),
    },
    {
      name: "selfmade-major-version.e57",
      fault: "unknown-major-version",
      derivation: "将偏移 8 的 uint32 majorVersion 从 1 改为 2 并重算第 0 页 CRC,其余字节不变",
      expected: "E57-rejected ... ErrorUnknownFileVersion",
      bytes: patchHeaderPage(positive, 8, (() => { const v = Buffer.alloc(4); v.writeUInt32LE(2, 0); return v; })()),
    },
    {
      name: "selfmade-file-length.e57",
      fault: "declared-length-overflow",
      derivation: "将偏移 16 的 uint64 filePhysicalLength 改为 0xFFFFFFFFFFFFFFFF 并重算第 0 页 CRC,其余字节不变",
      expected: "E57-rejected ... ErrorBadFileLength",
      bytes: patchHeaderPage(positive, 16, Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF])),
    },
    {
      name: "selfmade-truncated-tail.e57",
      fault: "truncated-tail-page",
      derivation: "截去文件末尾 1024 字节(一个完整物理页),头部声明的长度不再等于实际长度",
      expected: "E57-rejected ... ErrorBadFileLength",
      bytes: positive.subarray(0, positive.length - 1024),
    },
    {
      name: "selfmade-corrupt-page.e57",
      fault: "corrupt-page-crc",
      derivation: "将偏移 1600(第 1 物理页数据区内)的 1 个字节按位翻转 0xFF 且不改页尾 CRC,页 CRC32C 校验必然失败",
      expected: "E57-rejected ... ErrorBadChecksum",
      bytes: (() => { const copy = Buffer.from(positive); copy[1600] ^= 0xFF; return copy; })(),
    },
  ];
}

async function assertPreconditions(positive) {
  if (positive.length % 1024 !== 0) throw new Error(`正例物理长度不是 1024 的整数倍:${positive.length}`);
  if (positive.subarray(0, 8).toString("ascii") !== "ASTM-E57") throw new Error("派生基准不是合法 E57 签名");
  if (positive.readUInt32LE(8) !== 1 || positive.readUInt32LE(12) !== 0) throw new Error("派生基准版本不是 1.0");
  const declared = positive.readBigUInt64LE(16);
  if (declared !== BigInt(positive.length)) throw new Error(`派生基准头部长度 ${declared} 与实际 ${positive.length} 不符`);
}

export async function buildE57NegativeSamples({ out = defaultOut, positivePath = defaultPositive } = {}) {
  const positive = await readFile(positivePath);
  await assertPreconditions(positive);
  const samples = deriveNegativeSamples(positive);
  await mkdir(out, { recursive: true });
  const entries = [];
  for (const sample of samples) {
    await writeFile(path.join(out, sample.name), sample.bytes);
    entries.push({ name: sample.name, bytes: sample.bytes.length, sha256: sha256(sample.bytes),
      fault: sample.fault, derivation: sample.derivation, expected: sample.expected });
  }
  const manifest = {
    schemaVersion: 1,
    generatedBy: "scripts/fixtures/e57-negative/build-e57-negative-samples.mjs",
    source: "self-made",
    derivationBase: {
      path: path.relative(repositoryRoot, positivePath),
      bytes: positive.length,
      sha256: sha256(positive),
      source: "asmaloney/libE57Format-test-data main 分支快照(CC0-1.0),见 e57-test-data-SHA256SUMS.txt",
    },
    format: { name: "E57", version: "1.0", container: "ASTM E57 header + XML + 1024B CRC32C pages" },
    license: "CC0-1.0(派生自公有领域贡献的测试集;自造改动不引入新授权约束)",
    usageBoundary: "仅用于解析管线负例回归,不证明任何正向解析能力",
    samples: entries,
  };
  await writeFile(path.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(out, "SHA256SUMS.txt"),
    entries.map((entry) => `${entry.sha256} *${entry.name}`).join("\n") + "\n");
  return { manifest, out };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outIndex = process.argv.indexOf("--out");
  const result = await buildE57NegativeSamples(outIndex >= 0 ? { out: path.resolve(process.argv[outIndex + 1]) } : {});
  for (const entry of result.manifest.samples) console.log(`${entry.sha256}  ${entry.name} (${entry.bytes} B, ${entry.fault})`);
  console.log(`manifest: ${path.join(result.out, "manifest.json")}`);
  const existing = new Set((await readdir(result.out)).filter((name) => !name.startsWith("selfmade-")));
  console.log(`directory: ${result.out} (non-negative files present: ${[...existing].join(", ") || "none"})`);
}
