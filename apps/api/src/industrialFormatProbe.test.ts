import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeIndustrialFileStructure, probeJtFileStructure } from "./industrialFormatProbe.js";

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

describe("JT file structure probe", () => {
  it("只读取文件结构并识别 TOC，不冒充几何解析", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-jt-probe-"));
    directories.push(directory);
    const filePath = path.join(directory, "assembly.jt");
    await writeFile(filePath, jt10Fixture());

    const result = await probeJtFileStructure(filePath);

    expect(result).toMatchObject({
      status: "toc-recognized",
      recognizedFormat: "jt",
      probeScope: "structure-only",
      geometryParsed: false,
      version: { major: 10, minor: 5 },
      toc: { offset: 109, entryCount: 1, entrySizeBytes: 32 },
    });
  });

  it("对伪造文件返回 invalid 而不是抛出几何能力", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-jt-invalid-"));
    directories.push(directory);
    const filePath = path.join(directory, "invalid.jt");
    await writeFile(filePath, new Uint8Array(128));

    const result = await probeJtFileStructure(filePath);

    expect(result.status).toBe("invalid");
    expect(result.geometryParsed).toBe(false);
  });

  it("对 X_T 只读取有限样本并返回统一结构证据", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-xt-probe-"));
    directories.push(directory);
    const filePath = path.join(directory, "part.x_t");
    await writeFile(filePath, xtFixture());

    const result = await probeIndustrialFileStructure(filePath, "x_t");

    expect(result).toMatchObject({
      status: "header-recognized",
      recognizedFormat: "parasolid-x_t",
      probeScope: "structure-only",
      geometryParsed: false,
      evidence: { limitations: expect.any(Array) },
    });
  });
});

function jt10Fixture(): Uint8Array {
  const bytes = new Uint8Array(145);
  const version = new TextEncoder().encode("Version 10.5 JT");
  bytes.fill(0x20, 0, 75);
  bytes.set(version, 0);
  bytes.set([0x20, 0x0a, 0x0d, 0x0a, 0x20], 75);
  bytes[80] = 0;
  const view = new DataView(bytes.buffer);
  view.setInt32(81, 0, true);
  view.setBigUint64(85, 109n, true);
  view.setInt32(109, 1, true);
  return bytes;
}

function xtFixture(): Uint8Array {
  const modeller = ": TRANSMIT FILE created by modeller version 3100154";
  const schema = "SCH_3100154_31001";
  const header = [
    "**ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz*****************",
    "***********PARASOLID!\"#$%&'()*+,-./:;<=>?@[\\\\]^_`{|}~0123456789*********",
    "*******************PART1;",
    "APPL=Test; FORMAT=text;",
    "**PART2;",
    "SCH=SCH_3100154_31001; USFLD_SIZE=0;",
    "**PART3;",
    "**END_OF_HEADER********************************************************",
  ].join("\n");
  return new TextEncoder().encode(`${header}\nT${modeller.length} ${modeller}${schema.length} ${schema}0\n1 0`);
}
