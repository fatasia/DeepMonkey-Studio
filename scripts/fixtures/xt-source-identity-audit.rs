//! Raw X_T ownership oracle, independent of cad-xt lowering and tessellation.
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use xt_parser::{
    entity::{Entities, RawEntity},
    schema,
};

fn entity<'a>(
    index: &BTreeMap<usize, &'a RawEntity>,
    handle: usize,
    kind: u16,
) -> Result<&'a RawEntity, String> {
    index
        .get(&handle)
        .copied()
        .filter(|e| e.type_id == kind)
        .ok_or_else(|| format!("handle {handle} is not type {kind}"))
}

fn shell_owner(
    entities: &Entities,
    index: &BTreeMap<usize, &RawEntity>,
    handle: usize,
) -> Result<usize, String> {
    let shell = entities.fields(entity(index, handle, schema::SHELL)?);
    if shell.len() != 9 {
        return Err("unsupported SHELL layout".into());
    }
    let region = entities.fields(entity(index, shell[7].as_ptr(), schema::REGION)?);
    if !(region.len() == 7 || (region.len() == 8 && region[7].as_ptr() == 0))
        || !matches!(region[6].as_char(), 'S' | 'V')
    {
        return Err("unsupported REGION layout".into());
    }
    let body = region[2].as_ptr();
    entity(index, body, schema::BODY)?;
    if shell[2].as_ptr() != 0 && shell[2].as_ptr() != body {
        return Err("SHELL body and REGION body disagree".into());
    }
    Ok(body)
}

fn ownership(entities: &Entities) -> Result<BTreeMap<usize, BTreeSet<usize>>, String> {
    let mut index = BTreeMap::new();
    let mut bodies = BTreeMap::new();
    for e in entities.iter() {
        if e.index == 0 || index.insert(e.index, e).is_some() {
            return Err("duplicate or zero entity handle".into());
        }
        if e.type_id == schema::BODY {
            bodies.insert(e.index, BTreeSet::new());
        }
    }
    for face in entities.iter().filter(|e| e.type_id == schema::FACE) {
        let fields = entities.fields(face);
        if fields.len() != 14 {
            return Err("unsupported FACE layout".into());
        }
        let body = shell_owner(entities, &index, fields[6].as_ptr())?;
        if fields[13].as_ptr() != 0 && shell_owner(entities, &index, fields[13].as_ptr())? != body {
            return Err("front and back FACE ownership disagree".into());
        }
        bodies
            .get_mut(&body)
            .ok_or("missing owning BODY")?
            .insert(face.index);
    }
    if bodies.is_empty() || bodies.values().any(BTreeSet::is_empty) {
        return Err("empty body/face identity set is not a mesh profile".into());
    }
    Ok(bodies)
}

fn audit(path: &Path) -> Result<serde_json::Value, String> {
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if metadata.len() > 64 * 1024 * 1024 {
        return Err("source byte budget exceeded".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let size = bytes.len();
    let text = xt_parser::decode(bytes);
    let (_, body) = xt_parser::header::split_header(&text).map_err(|e| e.to_string())?;
    let tline = schema::parse_tline(body).map_err(|e| e.to_string())?;
    let mut remaining = tline.body.as_str();
    let partitions = if tline.has_base_schema {
        schema::parse_schema_preamble(&mut remaining)
            .map_err(|e| e.to_string())?
            .partition_count
    } else {
        0
    };
    let (entities, truncated) = xt_parser::entity::parse_entities_opt(
        &mut remaining,
        partitions,
        tline.has_base_schema,
        tline.key_major,
    )
    .map_err(|e| e.to_string())?;
    if truncated.is_some() || !remaining.trim().is_empty() {
        return Err("incomplete source stream".into());
    }
    let bodies: Vec<_> = ownership(&entities)?.into_iter().map(|(body, faces)| serde_json::json!({
        "body": body.to_string(), "faces": faces.into_iter().map(|f| f.to_string()).collect::<Vec<_>>()
    })).collect();
    Ok(serde_json::json!({"schemaVersion":1,"source":path,"sourceBytes":size,"bodies":bodies}))
}

fn collect(path: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("symlink source is not allowed".into());
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
            collect(&entry.map_err(|e| e.to_string())?.path(), files)?;
        }
    } else if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("x_t"))
    {
        if files.len() >= 10_000 {
            return Err("file count budget exceeded".into());
        }
        files.push(path.to_owned());
    }
    Ok(())
}

fn run() -> Result<(), String> {
    let root = std::env::args()
        .nth(1)
        .ok_or("expected X_T source directory or file")?;
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    collect(&root, &mut files)?;
    files.sort();
    if files.is_empty() {
        return Err("no X_T sources".into());
    }
    for path in files {
        println!(
            "{}",
            audit(&path).map_err(|e| format!("{}: {e}", path.display()))?
        );
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(region_body: usize, shell_body: usize, front: usize, duplicate: bool) -> Entities {
        let body = vec!["0"; 22].join(" ");
        let face = format!("14 4 2 0 ? 0 0 0 2 0 + 0 0 0 0 {front} ");
        let stream = format!(
            "12 1 {body} 13 2 1 0 {shell_body} 0 4 0 0 3 0 19 3 1 0 {region_body} 0 0 2 S {face}{}1 0",
            if duplicate { face.as_str() } else { "" }
        );
        let mut input = stream.as_str();
        let (entities, truncated) =
            xt_parser::entity::parse_entities_opt(&mut input, 0, false, 9).unwrap();
        assert!(truncated.is_none());
        assert!(input.trim().is_empty());
        entities
    }
    #[test]
    fn follows_raw_ownership_without_lowering() {
        assert_eq!(
            ownership(&fixture(1, 1, 0, false)).unwrap(),
            BTreeMap::from([(1, BTreeSet::from([4]))])
        );
    }
    #[test]
    fn rejects_dangling_wrong_type_conflicting_and_duplicate_identity() {
        for entities in [
            fixture(9, 1, 0, false),
            fixture(2, 1, 0, false),
            fixture(1, 9, 0, false),
            fixture(1, 1, 9, false),
            fixture(1, 1, 0, true),
        ] {
            assert!(ownership(&entities).is_err());
        }
    }
}
