import type { SceneCapability, SceneCommand } from "@bim-studio/scene-sdk";
import type { ServerProfile } from "@bim-studio/server-sdk";
import type { JsonValue } from "@bim-studio/contracts";

// If the public declarations regress to any, TypeScript reports unused directives.
// @ts-expect-error Capability names form a closed public vocabulary.
export const unknownCapability: SceneCapability = "studio.not-a-capability";
// @ts-expect-error Visibility is boolean, not an arbitrary string.
export const invalidCommand: SceneCommand = { id: "test", type: "object.set-visibility", target: { kind: "scene", sceneId: "s1" }, visible: "yes" };
// @ts-expect-error Server addresses are strings.
export const invalidProfile: ServerProfile = { baseUrl: 42 };
// @ts-expect-error Serialized values cannot contain executable functions.
export const invalidJson: JsonValue = () => 42;
