import os, shutil, subprocess, sys

WT = "D:/Documents/bim/bim-studio-head/"
SRC = "D:/Documents/bim/bim-studio/"
GROUP_A = ["renderTargets", "pipelines", "pbrPipelineSet", "pbrOpaquePass"]
GROUP_B = ["pbrFramePlanResources", "pbrPostProcessChain", "pbrBackgroundPass", "pbrMainBindings",
           "clusterLodRenderSlot", "clusterLodSlotSupport", "pbrDepthResolve", "pbrMsaaCapability", "pbrFramePlanExecutor"]
FIXED = ["deepWebGpuOptions"]
UNTRACKED = {"pbrDepthResolve", "pbrMsaaCapability"}

paths = {name: f"packages/deep-engine/src/webgpu/{name}.ts" for name in GROUP_A + GROUP_B}
paths["deepWebGpuOptions"] = "packages/deep-engine/src/threeBridge/deepWebGpuOptions.ts"

def to_head(names):
    for name in names:
        path = paths[name]
        if name in UNTRACKED:
            if os.path.exists(WT + path): os.remove(WT + path)
        else:
            subprocess.run(["git", "checkout", "HEAD", "--", path], cwd=WT, check=True)

def to_mine(names):
    for name in names:
        shutil.copyfile(SRC + paths[name], WT + paths[name])

mode = sys.argv[1]
to_mine(FIXED)
to_head(GROUP_A + GROUP_B)
if mode == "set-only":
    to_mine(["pbrPipelineSet"])
elif mode == "pipelines-only":
    to_mine(["pipelines"])
elif mode == "rt-only":
    to_mine(["renderTargets"])
elif mode == "opaque-only":
    to_mine(["pbrOpaquePass"])
elif mode == "set-pipelines":
    to_mine(["pbrPipelineSet", "pipelines"])
print("applied", mode)
