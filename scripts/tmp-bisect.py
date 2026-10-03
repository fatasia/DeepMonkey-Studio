import os, shutil, subprocess, sys

WT = "D:/Documents/bim/bim-studio-head/"
SRC = "D:/Documents/bim/bim-studio/"
GROUP_A = ["renderTargets", "pipelines", "pbrPipelineSet", "pbrOpaquePass"]
GROUP_B = ["pbrFramePlanResources", "pbrPostProcessChain", "pbrBackgroundPass", "pbrMainBindings",
           "clusterLodRenderSlot", "clusterLodSlotSupport", "pbrDepthResolve", "pbrMsaaCapability", "pbrFramePlanExecutor"]
FIXED = ["deepWebGpuOptions"]

paths = {name: f"packages/deep-engine/src/webgpu/{name}.ts" for name in GROUP_A + GROUP_B}
paths["deepWebGpuOptions"] = "packages/deep-engine/src/threeBridge/deepWebGpuOptions.ts"
UNTRACKED = {"pbrDepthResolve", "pbrMsaaCapability"}

def to_head(names):
    for name in names:
        path = paths[name]
        if name in UNTRACKED:
            if os.path.exists(WT + path): os.remove(WT + path)
        else:
            subprocess.run(["git", "checkout", "HEAD", "--", path], cwd=WT, check=True)

def to_mine(names):
    for name in names:
        if name in UNTRACKED:
            shutil.copyfile(SRC + paths[name], WT + paths[name])
        else:
            shutil.copyfile(SRC + paths[name], WT + paths[name])

mode = sys.argv[1]
to_mine(FIXED)
if mode == "a-only":
    to_head(GROUP_B); to_mine(GROUP_A)
elif mode == "b-only":
    to_head(GROUP_A); to_mine(GROUP_B)
elif mode == "all":
    to_mine(GROUP_A + GROUP_B)
elif mode == "clean":
    to_head(GROUP_A + GROUP_B)
print("applied", mode)
