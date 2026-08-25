import {
  applicationToSceneSnapshotV1,
  migrateSceneSnapshotV1,
  type ApplicationDocument,
  type SceneSnapshot
} from "@bim-studio/contracts";
import { ApplicationStore } from "@bim-studio/studio-core";

export class ApplicationSession {
  readonly store = new ApplicationStore();

  openDocument(application: ApplicationDocument): ApplicationDocument {
    this.store.load(application);
    return this.store.getState().document!;
  }

  loadSceneDraft(snapshot: SceneSnapshot): ApplicationDocument {
    const application = migrateSceneSnapshotV1(snapshot);
    this.store.load(application);
    return application;
  }

  captureSceneDraft(snapshot: SceneSnapshot): SceneSnapshot {
    const application = migrateSceneSnapshotV1(snapshot);
    this.store.load(application);
    return applicationToSceneSnapshotV1(application, snapshot.id);
  }

  getDocument(): ApplicationDocument | undefined {
    return this.store.getState().document;
  }
}
