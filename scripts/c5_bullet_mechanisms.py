"""Test-only Bullet mechanisms; actual constraints/forces, never assigned trajectories."""
import json
import pybullet as p


def gear(out, meta):
    client = p.connect(p.DIRECT)
    try:
        p.setGravity(*meta["gravity"])
        p.setTimeStep(meta["fixedStepSeconds"])
        p.setPhysicsEngineParameter(numSolverIterations=meta["solverIterations"], deterministicOverlappingPairs=1)
        links = []
        for name, center in [("a", .045), ("b", -.045)]:
            links.append(f'''<link name="{name}"><inertial><origin xyz="0 0 {center}"/><mass value="0.6"/>
<inertia ixx="0.00052" ixy="0" ixz="0" iyy="0.00052" iyz="0" izz="0.001"/></inertial>
<collision><origin xyz="0 0 {center}"/><geometry><box size="0.1 0.1 0.02"/></geometry></collision></link>
<joint name="{name}-axis" type="continuous"><parent link="world"/><child link="{name}"/>
<origin xyz="0 0 {0 if name == "a" else -.04}"/><axis xyz="0 0 1"/><dynamics damping="0" friction="0"/></joint>''')
        path = out / "gear-input.urdf"
        path.write_text('<robot name="C5-gear"><link name="world"/>' + ''.join(links) + '</robot>', encoding="utf8")
        body = p.loadURDF(str(path), useFixedBase=True, flags=p.URDF_USE_INERTIA_FROM_FILE)
        for index in [0, 1]:
            p.changeDynamics(body, index, linearDamping=0, angularDamping=0)
            p.setJointMotorControl2(body, index, p.VELOCITY_CONTROL, force=0)
        constraint = p.createConstraint(body, 0, body, 1, p.JOINT_GEAR, [0, 0, 1], [0, 0, 0], [0, 0, 0])
        # Bullet Jacobian enforces velocityA + gearRatio * velocityB = 0.
        p.changeConstraint(constraint, gearRatio=-1 / meta["ratio"], maxForce=1000, erp=.2)
        p.setJointMotorControl2(body, 0, p.VELOCITY_CONTROL, targetVelocity=meta["driverVelocity"], force=10)
        driver, follower = [], []
        for _ in range(meta["steps"]):
            p.stepSimulation()
            driver.append(p.getJointState(body, 0)[0])
            follower.append(p.getJointState(body, 1)[0])
        return {"anglesDriver": driver, "anglesFollower": follower}
    finally:
        p.disconnect(client)


def slider(out, meta):
    client = p.connect(p.DIRECT)
    try:
        p.setGravity(0, 0, 0)
        p.setTimeStep(meta["step"])
        p.setPhysicsEngineParameter(numSolverIterations=meta["solverIterations"], deterministicOverlappingPairs=1)
        path = out / "slider-input.urdf"
        path.write_text('''<robot name="C5-slider"><link name="world"/><link name="slider"><inertial>
<mass value="0.5"/><inertia ixx="0.0001333333333333" ixy="0" ixz="0" iyy="0.0002166666666667" iyz="0" izz="0.0002166666666667"/></inertial>
<collision><geometry><box size="0.06 0.04 0.04"/></geometry></collision></link>
<joint name="slider-x" type="prismatic"><parent link="world"/><child link="slider"/><axis xyz="1 0 0"/>
<limit lower="-1" upper="1" effort="1000" velocity="100"/><dynamics damping="0" friction="0"/></joint></robot>''', encoding="utf8")
        body = p.loadURDF(str(path), useFixedBase=True, flags=p.URDF_USE_INERTIA_FROM_FILE)
        p.changeDynamics(body, 0, linearDamping=0, angularDamping=0)
        p.setJointMotorControl2(body, 0, p.VELOCITY_CONTROL, force=0)
        positions = []
        for _ in range(meta["steps"]):
            position, velocity = p.getJointState(body, 0)[:2]
            force = meta["stiffness"] * (meta["target"] - position) - meta["damping"] * velocity
            p.setJointMotorControl2(body, 0, p.TORQUE_CONTROL, force=force)
            p.stepSimulation()
            positions.append(p.getLinkState(body, 0, computeForwardKinematics=1)[4])
        return positions
    finally:
        p.disconnect(client)


def mechanism_receipts(out):
    gear_meta = json.loads((out / "web-gear.json").read_text(encoding="utf8"))["meta"]
    slider_meta = json.loads((out / "web-slider.json").read_text(encoding="utf8"))["meta"]
    return {"gear": [gear(out, gear_meta) for _ in range(2)], "slider": [slider(out, slider_meta) for _ in range(2)]}
