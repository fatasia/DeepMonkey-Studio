"""Independent test-only Bullet output. Uses a pinned locally built package."""
import hashlib
import importlib.metadata
import json
import math
import pathlib
import sys

import pybullet as p

root = pathlib.Path(__file__).resolve().parents[1]
out = root / "test-output/c5-bullet"
version = importlib.metadata.version("pybullet")
if version != "3.2.7":
    raise RuntimeError("Expected pinned pybullet 3.2.7")


def stack(meta):
    client = p.connect(p.DIRECT)
    try:
        p.setGravity(*meta["gravity"])
        p.setTimeStep(meta["fixedStepSeconds"])
        p.setPhysicsEngineParameter(numSolverIterations=meta["solverIterations"], deterministicOverlappingPairs=1)
        ground = p.createCollisionShape(p.GEOM_BOX, halfExtents=[2, .1, 2])
        shape = p.createCollisionShape(p.GEOM_BOX, halfExtents=[meta["halfExtents"]] * 3)
        pad = p.createMultiBody(0, ground, basePosition=[0, -.1, 0])
        p.changeDynamics(pad, -1, lateralFriction=math.sqrt(meta["friction"]), restitution=0)
        bodies = [p.createMultiBody(meta["mass"], shape, basePosition=[0, y, 0]) for y in [.1, .3, .5]]
        for body in bodies:
            # Bullet combines friction by product; Rapier combines it by average.
            p.changeDynamics(body, -1, lateralFriction=math.sqrt(meta["friction"]), restitution=meta["restitution"],
                             linearDamping=0, angularDamping=0, ccdSweptSphereRadius=.05, contactProcessingThreshold=0)
        p.resetBaseVelocity(bodies[-1], linearVelocity=meta["topBoxInitialVelocity"])
        poses = []
        for _ in range(meta["steps"]):
            p.stepSimulation()
            poses.append([dict(zip(["p", "q"], p.getBasePositionAndOrientation(body))) for body in bodies])
        return poses
    finally:
        p.disconnect(client)


def cloth(source, round_id):
    config, initial = source["config"], source["runs"][round_id]["initial"]
    path = out / "cloth-input.obj"
    lines = ["v " + " ".join(map(str, v)) for v in initial]
    cols, rows = config["columns"], config["rows"]
    for y in range(rows - 1):
        for x in range(cols - 1):
            a = y * cols + x + 1
            lines.extend([f"f {a} {a+1} {a+cols}", f"f {a+1} {a+cols+1} {a+cols}"])
    path.write_text("\n".join(lines), encoding="utf8")
    client = p.connect(p.DIRECT)
    try:
        p.resetSimulation(p.RESET_USE_DEFORMABLE_WORLD)
        p.setGravity(*config["gravity"])
        p.setTimeStep(config["dtSeconds"] / config["substeps"])
        body = p.loadSoftBody(str(path), mass=config["mass"] * len(initial), useNeoHookean=0,
                             useMassSpring=1, useBendingSprings=0, springElasticStiffness=40,
                             springDampingStiffness=.1, useSelfCollision=0)
        mesh = p.getMeshData(body, -1, flags=p.MESH_DATA_SIMULATION_MESH)[1]
        if len(mesh) != len(initial):
            raise RuntimeError("Bullet changed cloth mesh node count")
        mapping = [min(range(len(mesh)), key=lambda i: math.dist(vertex, mesh[i])) for vertex in initial]
        if len(set(mapping)) != len(initial) or max(math.dist(initial[i], mesh[j]) for i, j in enumerate(mapping)) > 1e-6:
            raise RuntimeError("Cloth vertex provenance drift")
        for index in source["pinned"]:
            p.createSoftBodyAnchor(body, mapping[index], -1, -1)
        poses = []
        for _ in range(source["steps"]):
            for _ in range(config["substeps"]):
                p.stepSimulation()
            mesh = p.getMeshData(body, -1, flags=p.MESH_DATA_SIMULATION_MESH)[1]
            poses.append([mesh[j] for j in mapping])
        return poses
    finally:
        p.disconnect(client)


stack_input = json.loads((out / "web-stack-poses.json").read_text(encoding="utf8"))
cloth_input = json.loads((out / "cloth-input.json").read_text(encoding="utf8"))
result = {"version": version, "apiVersion": p.getAPIVersion(), "host": "Bullet DIRECT; test-only",
          "inputs": {name: hashlib.sha256((out / name).read_bytes()).hexdigest()
                     for name in ["web-stack-poses.json", "cloth-input.json"]},
          "stack": [stack(stack_input["meta"]) for _ in range(2)],
          "cloth": [cloth(cloth_input, i) for i in range(2)],
          "freeFall": [cloth(cloth_input["freeFall"], i) for i in range(2)]}
(out / "bullet.json").write_text(json.dumps(result, allow_nan=False), encoding="utf8")
print("Bullet stack/cloth two-round output written")
