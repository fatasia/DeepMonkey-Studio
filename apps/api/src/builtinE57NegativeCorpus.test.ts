import {execFile as execFileCallback} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {afterEach,describe,expect,it} from "vitest";
import {inspectBuiltinE57} from "./builtinE57Inspection.js";
import {auditE57PointBlocks} from "./e57PointBlockAudit.js";

const execFile=promisify(execFileCallback);
const root=fileURLToPath(new URL("../../../",import.meta.url));
const base=path.join(root,"data/external-assets/industrial-format-plan");
const executable=path.join(base,"build-trial/e57-reader-cli/Release/e57-reader.exe");
const self=path.join(base,"samples/extracted/libE57Format-test-data/self");
const generator=path.join(root,"scripts/fixtures/e57-negative/build-e57-negative-samples.mjs");

// 派生基准正例(上游 CC0 测试集,e57-test-data-SHA256SUMS.txt 已锁)与其上的确定性负样本。
// 哈希在此锁定:派生逻辑或基准变化都会被这里拦下,防止负例语义漂移。
const derivationBaseSha256="58e7cfbb3e9cef777c4cd8f52aff2ff704fcf6dd3aea4b420430adaa1cdb978d";
const expectedNegatives:{
  name:string;fault:string;sha256:string;expected:RegExp;
}[]=[
  {name:"selfmade-bad-magic.e57",fault:"bad-magic",sha256:"47b6340fe1065d5d4f97415d302cdb5d5d896bdec85fae2da100843ffdc3e56f",
    expected:/E57-rejected: file signature not ASTM-E57 \(ErrorBadFileSignature\)/},
  {name:"selfmade-major-version.e57",fault:"unknown-major-version",sha256:"eb56007e0d31b61389101f96f28de2232c62cc52b8fc4c593f483c4263b2c9d9",
    expected:/E57-rejected: incompatible file version \(ErrorUnknownFileVersion\)/},
  {name:"selfmade-file-length.e57",fault:"declared-length-overflow",sha256:"217e43db24b10dd402660b7e442ca9fec69f4c3a7650fec0a6a1a38c1cd7978b",
    expected:/E57-rejected: size in file header not same as actual \(ErrorBadFileLength\)/},
  {name:"selfmade-truncated-tail.e57",fault:"truncated-tail-page",sha256:"92720fd7c8c20eafc48dab7de586659119ec117708c032c57831c68a758718c7",
    expected:/E57-rejected: size in file header not same as actual \(ErrorBadFileLength\)/},
  {name:"selfmade-corrupt-page.e57",fault:"corrupt-page-crc",sha256:"f95686f0b9bb7e75690625156dab14b4d83269cb87fba6a78c49d69229d13067",
    expected:/E57-rejected: checksum mismatch, file is corrupted \(ErrorBadChecksum\)/},
];

const folders:string[]=[];
afterEach(async()=>{for(const folder of folders.splice(0))await rm(folder,{recursive:true,force:true});});
async function attemptRoot(){const folder=await mkdtemp(path.join(tmpdir(),"e57-negative-test-"));folders.push(folder);return folder;}
async function generateNegatives(){
  const out=await mkdtemp(path.join(tmpdir(),"e57-negative-gen-"));folders.push(out);
  await execFile(process.execPath,[generator,"--out",out],{cwd:root});
  return out;
}

describe.skipIf(process.platform!=="win32")("E57 negative corpus: malformed sources are rejected with readable errors",()=>{
  it("rebuilds deterministic self-made negatives and keeps manifest, sums and bytes consistent",async()=>{
    const out=await generateNegatives();
    const manifest=JSON.parse(await readFile(path.join(out,"manifest.json"),"utf8"));
    expect(manifest.source).toBe("self-made");
    expect(manifest.derivationBase.sha256).toBe(derivationBaseSha256);
    expect(manifest.samples.map((sample:{name:string})=>sample.name))
      .toEqual(expectedNegatives.map(negative=>negative.name));
    const sums=await readFile(path.join(out,"SHA256SUMS.txt"),"utf8");
    for(const negative of expectedNegatives){
      const bytes=await readFile(path.join(out,negative.name));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(negative.sha256);
      expect(sums).toContain(`${negative.sha256} *${negative.name}`);
      const recorded=manifest.samples.find((sample:{name:string;sha256:string})=>sample.name===negative.name);
      expect(recorded.sha256).toBe(negative.sha256);
    }
  });

  it.for(expectedNegatives.map(negative=>[negative.name,negative] as const))(
    "rejects %s through the full inspect chain with its specific error",
    async([,negative])=>{
      const out=await generateNegatives(),folder=await attemptRoot();
      const failure=await inspectBuiltinE57({source:path.join(out,negative.name),executable,attemptRoot:folder})
        .catch(error=>error as Error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toMatch(negative.expected);
      // 被拒来源不产生任何 ready 产物,自己的 attempt 已清理。
      expect((await readdir(folder)).length).toBe(0);
    },15000);

  it("rejects the upstream malformed corpus with readable errors, including the reader-crash sample",async()=>{
    const folder=await attemptRoot();
    const upstream:{file:string;expected:RegExp|null}[]=[
      ["bad-crc.e57",/E57-rejected: checksum mismatch, file is corrupted \(ErrorBadChecksum\)/],
      ["InvalidFileLength.e57",/E57-rejected: .*1024 bytes|E57-rejected: size in file header not same as actual/],
      ["InvalidCVHeader.e57",/E57-rejected: a CompressedVector binary header was bad \(ErrorBadCVHeader\)/],
      ["NoPrototype.e57",/E57-rejected: bad prototype in CompressedVectorNode \(ErrorBadPrototype\)/],
      // 上游已知会让 reader 进程崩溃(exit=139);产品侧契约是非零退出即拒绝,错误文本不保证。
      ["MultipleScansHomogeneousError.e57",null],
    ];
    for(const [file,expected] of upstream){
      const failure=await inspectBuiltinE57({source:path.join(self,file),executable,attemptRoot:folder})
        .catch(error=>error as Error);
      expect(failure).toBeInstanceOf(Error);
      if(expected)expect(failure.message,`readable error for ${file}`).toMatch(expected);
      else expect(failure.message,`non-zero exit for ${file}`).toMatch(/执行失败/);
    }
    expect((await readdir(folder)).length).toBe(0);
  },30000);

  it("accepts valid zero-content sources without inventing points",async()=>{
    for(const file of ["empty.e57","ZeroPoints.e57"]){
      const folder=await attemptRoot();
      const output=await inspectBuiltinE57({source:path.join(self,file),executable,attemptRoot:folder});
      expect(output.points).toBe(0);
      expect(output.manifest.scans.every((scan:{points:number})=>scan.points===0)).toBe(true);
      expect(output.manifest.worldBounds).toBeNull();
      expect(output.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  },15000);

  it("still rejects tampered intermediates after a successful inspect of a real source",async()=>{
    // 家族核对:格式级负例之外,既有中间产物审计(截断/越界)仍被同一条链阻断。
    const folder=await attemptRoot(),source=path.join(self,"ColouredCubeDouble.e57");
    const output=await inspectBuiltinE57({source,executable,attemptRoot:folder});
    const file=path.join(output.directory,"points.ndjson");
    await writeFile(file,(await readFile(file,"utf8")).slice(0,-1));
    await expect(auditE57PointBlocks(output.directory)).rejects.toThrow("截断");
  },15000);
});
