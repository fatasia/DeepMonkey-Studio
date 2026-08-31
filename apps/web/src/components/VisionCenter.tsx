import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { useVisionCenterController } from "./useVisionCenterController";
import { VisionCenterDialogs } from "./VisionCenterDialogs";
import { VisionCenterWorkspace } from "./VisionCenterWorkspace";

export function VisionCenter({
  locale,
  project,
  scenes,
  onBack,
}: {
  locale: AppLocale;
  project: ProjectRecord;
  scenes: SceneSnapshot[];
  onBack: () => void;
}) {
  const controller = useVisionCenterController({
    locale,
    project,
    scenes,
    onBack,
  });
  return (
    <main className="vision-page">
      <VisionCenterWorkspace controller={controller} />
      <VisionCenterDialogs controller={controller} />
    </main>
  );
}
