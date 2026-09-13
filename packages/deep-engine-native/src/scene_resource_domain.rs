use std::collections::HashMap;

use crate::scene_resource_identity::{SceneResourceManifest, VersionedResourceIdentity};

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct RevisionKey {
    kind: &'static str,
    id: String,
    revision: u64,
}

#[derive(Debug)]
pub struct SceneRevisionTicket {
    epoch: u64,
    additions: Vec<(
        RevisionKey,
        crate::scene_resource_identity::ContentFingerprint,
    )>,
}

#[derive(Debug)]
pub struct SceneResourceDomain {
    epoch: u64,
    revisions: HashMap<RevisionKey, crate::scene_resource_identity::ContentFingerprint>,
}

impl SceneResourceDomain {
    pub fn new(epoch: u64) -> Self {
        Self {
            epoch,
            revisions: HashMap::new(),
        }
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn reset(&mut self, epoch: u64) {
        self.epoch = epoch;
        self.revisions.clear();
    }

    pub fn stage(&self, manifest: &SceneResourceManifest) -> Result<SceneRevisionTicket, String> {
        let mut staged = HashMap::new();
        let mut additions = Vec::new();
        for (kind, resources) in [
            ("geometry", manifest.geometries.as_slice()),
            ("texture", manifest.textures.as_slice()),
        ] {
            for resource in resources {
                stage_resource(&self.revisions, &mut staged, &mut additions, kind, resource)?;
            }
        }
        Ok(SceneRevisionTicket {
            epoch: self.epoch,
            additions,
        })
    }

    pub fn commit(&mut self, ticket: SceneRevisionTicket) -> Result<(), String> {
        if ticket.epoch != self.epoch {
            return Err(format!(
                "native scene candidate epoch {} is stale; current device epoch is {}",
                ticket.epoch, self.epoch
            ));
        }
        self.revisions.extend(ticket.additions);
        Ok(())
    }

    pub fn tracked_revisions(&self) -> usize {
        self.revisions.len()
    }
}

fn stage_resource(
    committed: &HashMap<RevisionKey, crate::scene_resource_identity::ContentFingerprint>,
    staged: &mut HashMap<RevisionKey, crate::scene_resource_identity::ContentFingerprint>,
    additions: &mut Vec<(
        RevisionKey,
        crate::scene_resource_identity::ContentFingerprint,
    )>,
    kind: &'static str,
    resource: &VersionedResourceIdentity,
) -> Result<(), String> {
    let key = RevisionKey {
        kind,
        id: resource.id.clone(),
        revision: resource.revision,
    };
    if let Some(previous) = committed.get(&key).or_else(|| staged.get(&key)) {
        if previous != &resource.content {
            return Err(format!(
                "native {kind} {} revision {} was reused for different content",
                resource.id, resource.revision
            ));
        }
        return Ok(());
    }
    staged.insert(key.clone(), resource.content.clone());
    additions.push((key, resource.content.clone()));
    Ok(())
}
