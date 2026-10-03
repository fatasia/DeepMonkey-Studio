import io, sys

p = "D:/Documents/bim/bim-studio-head/packages/deep-engine/src/webgpu/pipelines.ts"
s = io.open(p, encoding="utf-8").read()
NL = chr(10)
base3 = '    { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },' + NL + "  ] });"
mode = sys.argv[1]
if mode == "b5":
    add = ('    { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },' + NL +
      '    { binding: 5, visibility: GPUShaderStage.FRAGMENT,' + NL +
      '      texture: { sampleType: "float", viewDimension: "2d-array" } },' + NL + "  ] });")
    assert base3 in s
    s = s.replace(base3, add)
elif mode == "storage34":
    add = ('    { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },' + NL +
      '    { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },' + NL +
      '    { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },' + NL + "  ] });")
    assert base3 in s
    s = s.replace(base3, add)
elif mode == "b5-nofilter":
    add = ('    { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },' + NL +
      '    { binding: 5, visibility: GPUShaderStage.FRAGMENT,' + NL +
      '      texture: { sampleType: "unfilterable-float", viewDimension: "2d-array" } },' + NL + "  ] });")
    assert base3 in s
    s = s.replace(base3, add)
io.open(p, "w", encoding="utf-8", newline=NL).write(s)
print("applied", mode)
