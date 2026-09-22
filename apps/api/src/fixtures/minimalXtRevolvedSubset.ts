const PROFILE = [
  [29, 0, 0.0331625],
  [30, 0.003, 0.0301625],
  [7, -0.0510380808081788, 0.0301625],
  [17, -0.0540266565657247, 0.0329009375],
  [31, 0.061, 0.039290625],
  [34, 0.063, 0.039290625],
  [37, 0.063, 0.04445],
  [40, 0.02, 0.0515],
  [43, 0.01159813717221072, 0.04445],
  [46, 0, 0.04445],
] as const;

/**
 * 测试夹具由许可清晰的真实样本测量值重建，不复制原文件实体流。
 * 它只验证当前 clean-room 子集合同，不能作为通用 X_T 语料。
 */
export function minimalXtRevolvedSubsetFixture(): Uint8Array {
  const header = [
    "**ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
    "**PARASOLID",
    "**PART1;",
    "APPL=DeepMonkey Studio clean-room regression;",
    "FORMAT=text;",
    "**PART2;",
    "SCH=SCH_2401231_20000;",
    "USFLD_SIZE=0;",
    "**PART3;",
    "**END_OF_HEADER********",
  ].join("\n");
  const identification = "T51 : TRANSMIT FILE created by modeller version 240123123 SCH_2401231_20000_1300";
  const circles = PROFILE.map(([id, axial, radius]) =>
    `31 ${id} 100 0 1 2 3 0 ${axial} 0 0 -1 0 0 0 0 1 ${radius}`,
  );
  const faces = PROFILE.map((_, index) =>
    `14 ${200 + index} 1 2 ?3 4 5 5 ${300 + index} -0 0`,
  );
  const torus = "54 86 100 0 1 2 3 0 .061 0 0 -1 0 0 .032290625 .007 0 0 1";
  return new TextEncoder().encode(`${header}\n${identification}\nZ1 1 ${circles.join(" ")} ${faces.join(" ")} ${torus}`);
}
