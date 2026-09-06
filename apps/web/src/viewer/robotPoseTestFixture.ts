import { Group, Vector3 } from "three";
import { URDFJoint, URDFLink, URDFMimicJoint, URDFRobot } from "urdf-loader/src/URDFClasses.js";
import type { RobotAssetDefinition, RobotJointDefinition } from "@bim-studio/contracts";
import { attachRobotRuntime } from "./robotPoseRuntime";

export const origin = { xyz: { x: 0, y: 0, z: 0 }, rpy: { x: 0, y: 0, z: 0 } };
export function robotDefinition(): RobotAssetDefinition {
  const joint = (name: string, type: RobotJointDefinition["type"], options: Partial<RobotJointDefinition> = {}): RobotJointDefinition => ({
    name, type, parent: "base", child: `${name}-link`, origin: structuredClone(origin), axis: { x: 0, y: 0, z: 1 }, ...options,
  });
  const joints = [joint("turn", "continuous"), joint("hinge", "revolute", { limit: { lower: -1, upper: 1 } }),
    joint("slide", "prismatic", { axis: { x: 1, y: 1, z: 0 }, limit: { lower: 0, upper: .2 } }), joint("fixed", "fixed"),
    joint("follower", "revolute", { limit: { lower: -1.5, upper: 1.5 }, mimic: { joint: "hinge", multiplier: 2, offset: .1 } }),
    joint("chain", "continuous", { mimic: { joint: "follower", multiplier: -2, offset: .2 } })];
  return { schemaVersion: 1, name: "Test robot", entryPath: "robot.urdf", rootLink: "base", joints,
    links: ["base", ...joints.map(item => item.child)].map(name => ({ name, visuals: [], collisions: [] })), materials: [], resources: [] };
}

export function robotPoseFixture(definition = robotDefinition()) {
  const object = new Group(), coordinates = new Group(), robot = new URDFRobot();
  coordinates.rotation.x = -Math.PI / 2; coordinates.add(robot); object.add(coordinates);
  robot.name = "base"; robot.joints = {}; robot.links = { base: robot };
  for (const definitionJoint of definition.joints) {
    const joint = definitionJoint.mimic ? new URDFMimicJoint() : new URDFJoint();
    joint.name = definitionJoint.name; joint.jointType = definitionJoint.type;
    joint.axis.copy(new Vector3(...Object.values(definitionJoint.axis)).normalize());
    joint.limit.lower = definitionJoint.limit?.lower ?? -Infinity; joint.limit.upper = definitionJoint.limit?.upper ?? Infinity;
    const link = new URDFLink(); link.name = definitionJoint.child; joint.add(link); robot.add(joint);
    robot.joints[joint.name] = joint; robot.links[link.name] = link;
  }
  attachRobotRuntime(object, robot, definition);
  return { object, robot, coordinates, definition };
}
