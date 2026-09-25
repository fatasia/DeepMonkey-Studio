export {
  readXtTextSegments,
  resolveGenericMaxBytes,
  XtGenericSegmentError,
  XT_GENERIC_DEFAULT_MAX_BYTES,
  XT_GENERIC_MAX_BYTES_CEILING,
  XT_GENERIC_MAX_BYTES_ENV,
  type XtSegmentHeader,
  type XtTextSegments,
  type XtEncodingClass,
} from "./segments.js";
export {
  parseXtTextDocument,
  type XtGenericDocument,
} from "./entityIndex.js";
export {
  parseCircleRecord,
  parseConeRecord,
  parseCylinderRecord,
  parsePlaneRecord,
  parseSphereRecord,
  parseTorusRecord,
  parseTransformRecord,
  XT_CLASS,
  type XtCircleCurve,
  type XtConeSurface,
  type XtCylinderSurface,
  type XtPlaneSurface,
  type XtSphereSurface,
  type XtSurface,
  type XtSurfaceFamily,
  type XtTorusSurface,
  type XtTransformRecord,
} from "./surfaces.js";
export {
  buildCylinderFromCoaxialCircles,
  circleMatchesSurface,
  inferCylinderSpanFromCircles,
  tessellateConePatch,
  tessellateCylinderPatch,
  tessellatePlanePatch,
  tessellateSphere,
  XT_ANGULAR_SEGMENTS,
  type AxialSpan,
  type XtTriangleMesh,
} from "./mesh.js";
export {
  buildSyntheticXtText,
  decodeSynthetic,
  type SyntheticXtSpec,
} from "./testing.js";
export {
  crossProduct,
  decodeLatin1,
  isIntegerToken,
  isNumberToken,
  isOrthogonal,
  isUnitVector,
  parseXtNumber,
  tokenizePayload,
  type Vec3,
} from "./tokens.js";
