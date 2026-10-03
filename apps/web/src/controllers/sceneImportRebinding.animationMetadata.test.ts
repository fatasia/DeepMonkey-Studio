import { expect, it } from 'vitest';
import { fullFixture } from '../controllers/sceneRendererRecoveryFullDomainFixture.testUtils';
import { rebindImportedSceneModels } from '../controllers/sceneImportRebinding';

it.each([false, true])('actual scene import rebind keeps animation machine references valid, explicit instance=%s', explicitInstance => {
  const f = fullFixture(), scene = f.persistence.makeSnapshot()!;
  if (!explicitInstance) delete scene.models[0]!.assetModelId;
  scene.animation = { ...scene.animation!, stateMachine: { enabled: true, initialStateId: 'idle', activeStateId: 'idle',
    transitionDuration: .25, states: [{ id: 'idle', name: 'Idle', modelId: 'pump-instance', clipId: 'Idle', loop: true }] } };
  const target = { ...f.context.project!, models: [{ ...f.context.project!.models[0]!, id: 'new-asset' }] }, before = structuredClone(scene);
  const idMap = new Map([[explicitInstance ? 'pump-asset' : 'pump-instance', 'new-asset']]);
  const result = rebindImportedSceneModels(scene, target, idMap);
  expect(result.missingModelCount).toBe(0);
  expect(result.scene.animation!.stateMachine!.states[0]!.modelId).toBe(explicitInstance ? 'pump-instance' : 'new-asset');
  expect(scene).toEqual(before);
});
