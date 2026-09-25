export { SceneTransformGraph } from "./SceneTransformGraph.js";
export { SceneTransformSpatialBridge } from "./SceneTransformSpatialBridge.js";
export { SCENE_CHANGESET_SCHEMA_VERSION, createSceneChangeset, applySceneChangeset, captureSceneChangesetInverse,
  type SceneChangeset, type SceneChangesetCommand, type SceneChangesetOutcome, type SceneChangesetRejection } from "./SceneChangeset.js";
export { SceneMutationGateway,
  type SceneMutationCommandParser, type SceneMutationExecution, type SceneMutationGatewayOptions,
  type SceneMutationIssue, type SceneMutationIssueReason, type SceneMutationPreparation } from "./SceneMutationGateway.js";
export { DEEP_SCENE_TRANSFORM_LIMITS } from "./validation.js";
export { localTransformMatrix, multiplySceneMatrices } from "./math.js";
export {
  SceneTransformGraphError,
  type SceneLocalMatrix,
  type SceneLocalTransform,
  type SceneLocalTrs,
  type SceneMatrix4,
  type SceneNormalMatrix3,
  type SceneNormalMatrixStatus,
  type SceneQuaternion,
  type SceneReparentOptions,
  type SceneTransformChange,
  type SceneTransformFlushResult,
  type SceneTransformGraphErrorCode,
  type SceneTransformGraphOptions,
  type SceneTransformGraphStats,
  type SceneTransformNodeId,
  type SceneTransformNodeInput,
  type SceneTransformNodePatch,
  type SceneTransformNodeSnapshot,
  type SceneWorldBoundsUpdate,
} from "./types.js";
export {
  SceneSpatialSyncError,
  type SceneSpatialSyncErrorCode,
  type SceneSpatialSyncResult,
  type SceneSpatialSyncStats,
  type SceneSpatialSyncTarget,
  type SceneTransformRevisionRecord,
} from "./spatialSyncTypes.js";
