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
        if self.revisions.len().saturating_add(additions.len()) > 65_536 {
            return Err("native scene revision-identity budget exhausted; reopen Viewer".into());
        }
        Ok(SceneRevisionTicket {
            epoch: self.epoch,
            additions,
        })
    }

    pub fn commit(&mut self, ticket: SceneRevisionTicket) -> Result<(), String> {
        self.validate_commit(&ticket)?;
        self.revisions.extend(ticket.additions);
        Ok(())
    }

    /// 只核验发布条件，不登记候选资源；允许宿主在呈现前预检。
    pub fn validate_commit(&self, ticket: &SceneRevisionTicket) -> Result<(), String> {
        if ticket.epoch != self.epoch {
            return Err(format!(
                "native scene candidate epoch {} is stale; current device epoch is {}",
                ticket.epoch, self.epoch
            ));
        }
        let mut new = 0usize;
        for (key, content) in &ticket.additions {
            match self.revisions.get(key) {
                Some(previous) if previous != content => {
                    return Err("native scene revision changed before commit".into());
                }
                None => new += 1,
                _ => {}
            }
        }
        if self.revisions.len().saturating_add(new) > 65_536 {
            return Err("native scene revision-identity budget exhausted; reopen Viewer".into());
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene_resource_identity::ContentFingerprint;
    fn manifest(id: &str, content: &str) -> SceneResourceManifest {
        SceneResourceManifest {
            geometries: vec![VersionedResourceIdentity {
                id: id.into(),
                revision: 1,
                content: ContentFingerprint(content.into()),
            }],
            textures: vec![],
            materials: vec![],
            instances: ContentFingerprint("instances".into()),
        }
    }
    #[test]
    fn stale_staged_revision_cannot_overwrite_a_committed_identity() {
        let mut domain = SceneResourceDomain::new(1);
        let a = domain.stage(&manifest("same", "a")).unwrap();
        let b = domain.stage(&manifest("same", "b")).unwrap();
        domain.validate_commit(&a).unwrap();
        domain.validate_commit(&b).unwrap();
        assert_eq!(domain.tracked_revisions(), 0);
        domain.commit(a).unwrap();
        assert!(domain.validate_commit(&b).unwrap_err().contains("changed"));
        assert!(domain.commit(b).is_err());
        assert_eq!(domain.tracked_revisions(), 1);
        assert!(domain.stage(&manifest("same", "a")).is_ok());
    }
    #[test]
    fn commit_preflight_does_not_reserve_revisions_or_survive_epoch_reset() {
        let mut domain = SceneResourceDomain::new(1);
        let candidate = domain.stage(&manifest("new", "a")).unwrap();
        domain.validate_commit(&candidate).unwrap();
        domain.validate_commit(&candidate).unwrap();
        assert_eq!(domain.tracked_revisions(), 0);
        domain.reset(2);
        assert!(
            domain
                .validate_commit(&candidate)
                .unwrap_err()
                .contains("stale")
        );
        assert!(domain.commit(candidate).unwrap_err().contains("stale"));
        assert_eq!(domain.tracked_revisions(), 0);
    }
    #[test]
    fn retained_revision_identity_budget_is_bounded_without_forgetting_old_content() {
        let mut domain = SceneResourceDomain::new(1);
        let candidate = domain.stage(&manifest("new", "a")).unwrap();
        for i in 0..65_536 {
            domain.revisions.insert(
                RevisionKey {
                    kind: "geometry",
                    id: i.to_string(),
                    revision: 1,
                },
                ContentFingerprint("a".into()),
            );
        }
        assert!(
            domain
                .stage(&manifest("new", "a"))
                .unwrap_err()
                .contains("budget")
        );
        assert!(domain.stage(&manifest("0", "a")).is_ok());
        assert!(domain.stage(&manifest("0", "b")).is_err());
        assert!(
            domain
                .validate_commit(&candidate)
                .unwrap_err()
                .contains("budget")
        );
        assert!(domain.commit(candidate).unwrap_err().contains("budget"));
        assert_eq!(domain.tracked_revisions(), 65_536);
    }
}
