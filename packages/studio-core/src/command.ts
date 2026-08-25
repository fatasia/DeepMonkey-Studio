import type { ApplicationDocument } from "@bim-studio/contracts";

let nextCommandId = 1;

function commandId(): string {
  return `command:${nextCommandId++}`;
}

export interface StudioCommand {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  execute(document: ApplicationDocument): ApplicationDocument;
}

export function createRenameApplicationCommand(name: string): StudioCommand {
  return {
    id: commandId(),
    type: "application.rename",
    label: `重命名应用为“${name}”`,
    execute(document) {
      return {
        ...structuredClone(document),
        metadata: { ...document.metadata, name }
      };
    }
  };
}
