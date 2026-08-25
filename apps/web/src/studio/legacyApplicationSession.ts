import {
  applicationToSceneSnapshotV1,
  migrateSceneSnapshotV1,
  type ApplicationDocument,
  type SceneSnapshot
} from "@bim-studio/contracts";
import { ApplicationStore } from "@bim-studio/studio-core";

export class LegacyApplicationSession {
  readonly store = new ApplicationStore();

  open(snapshot: SceneSnapshot): ApplicationDocument {
    const application = migrateSceneSnapshotV1(snapshot);
    this.store.load(application);
    return application;
  }

  capture(snapshot: SceneSnapshot): SceneSnapshot {
    const application = migrateSceneSnapshotV1(snapshot);
    this.store.load(application);
    return applicationToSceneSnapshotV1(application, snapshot.id);
  }

  getApplication(): ApplicationDocument | undefined {
    return this.store.getState().document;
  }
}
