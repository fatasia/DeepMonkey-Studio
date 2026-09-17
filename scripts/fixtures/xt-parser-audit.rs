//! Independent audit of the local X_T research parser; not a production importer.
//! Compile with rustc --edition=2024 --extern xt_parser=<rlib> -L dependency=<deps>.
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use xt_parser::{
    XtBody, XtBodyType,
    entity::{FieldVal, RawEntity},
    schema,
};

const MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_FILES: usize = 10_000;

fn collect(path: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err(format!("symlink not audited: {}", path.display()));
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
            collect(&entry.map_err(|e| e.to_string())?.path(), files)?;
        }
    } else if path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("x_t"))
    {
        files.push(path.to_owned());
        if files.len() > MAX_FILES {
            return Err("corpus file budget exceeded".into());
        }
    }
    Ok(())
}

// FACE node-id and global vertex handle bind a one-use raw witness to the
// typed fin (whose loop and fin handles are not retained by the research IR).
type IsolatedFin = (i64, usize);

fn isolated_links(index: usize, links: [usize; 7], valid_vertex: bool) -> bool {
    index != 0
        && links[1] == index
        && links[2] == index
        && links[3] != 0
        && valid_vertex
        && links[4..].iter().all(|value| *value == 0)
}

fn isolated_fin_witnesses<'a>(
    entities: &'a [RawEntity],
    fields: impl Fn(&'a RawEntity) -> &'a [FieldVal],
) -> BTreeSet<IsolatedFin> {
    let index: BTreeMap<_, _> = entities.iter().map(|e| ((e.type_id, e.index), e)).collect();
    let mut witnesses = BTreeSet::new();
    for fin in entities.iter().filter(|e| e.type_id == schema::FIN) {
        let f = fields(fin);
        let offset = match f.len() {
            9 => 0,
            10 => 1,
            _ => continue,
        };
        let p = |slot: usize| f[slot + offset].as_ptr();
        if !isolated_links(
            fin.index,
            std::array::from_fn(p),
            index.contains_key(&(schema::VERTEX, p(3))),
        ) {
            continue;
        }
        let Some(lp) = index.get(&(schema::LOOP, p(0))) else {
            continue;
        };
        let l = fields(lp);
        if l.len() < 4 || l[2].as_ptr() != fin.index {
            continue;
        }
        let Some(face) = index.get(&(schema::FACE, l[3].as_ptr())) else {
            continue;
        };
        let Some(face_id) = fields(face).first() else {
            continue;
        };
        witnesses.insert((face_id.as_i64(), p(3)));
    }
    witnesses
}

fn graph_findings(
    entities: &[RawEntity],
    bodies: &[XtBody],
    isolated: &BTreeSet<IsolatedFin>,
) -> BTreeMap<String, usize> {
    let mut findings = BTreeMap::new();
    let mut unused_isolated = isolated.clone();
    let mut keys = BTreeSet::new();
    let mut source = BTreeMap::<u16, usize>::new();
    for entity in entities {
        *source.entry(entity.type_id).or_default() += 1;
        if !keys.insert((entity.type_id, entity.index)) {
            *findings.entry("duplicate-type-index".into()).or_default() += 1;
        }
    }
    let mut output = BTreeMap::<u16, usize>::new();
    output.insert(schema::BODY, bodies.len());
    for body in bodies {
        if body.body_type == XtBodyType::Solid && body.shells.is_empty() {
            *findings.entry("solid-without-shell".into()).or_default() += 1;
        }
        *output.entry(schema::SHELL).or_default() += body.shells.len();
        *output.entry(schema::EDGE).or_default() += body.edges.len();
        *output.entry(schema::VERTEX).or_default() += body.vertices.len();
        for vertex in body.vertices.values() {
            if !body.points.contains_key(&vertex.point_key) {
                *findings.entry("missing-vertex-point".into()).or_default() += 1;
            }
        }
        for shell in &body.shells {
            *output.entry(schema::FACE).or_default() += shell.faces.len();
            for face in &shell.faces {
                if !body.surfaces.contains_key(&face.surface_key) {
                    *findings.entry("missing-face-surface".into()).or_default() += 1;
                }
                *output.entry(schema::LOOP).or_default() += face.loops.len();
                for lp in &face.loops {
                    *output.entry(schema::FIN).or_default() += lp.fins.len();
                    for fin in &lp.fins {
                        let isolated_fin = fin.edge_key == 0
                            && fin.pcurve_key.is_none()
                            && lp.fins.len() == 1
                            && fin.vertex_key.is_some_and(|vertex| {
                                body.vertices.contains_key(&vertex)
                                    && unused_isolated.remove(&(face.node_id, vertex))
                            });
                        if !body.edges.contains_key(&fin.edge_key) && !isolated_fin {
                            *findings.entry("missing-fin-edge".into()).or_default() += 1;
                        }
                        if fin
                            .vertex_key
                            .is_some_and(|key| !body.vertices.contains_key(&key))
                        {
                            *findings.entry("missing-fin-vertex".into()).or_default() += 1;
                        }
                    }
                }
            }
        }
    }
    // Counts are a necessary conservation check, not proof of identity or geometry.
    for kind in [
        schema::BODY,
        schema::SHELL,
        schema::FACE,
        schema::LOOP,
        schema::FIN,
        schema::EDGE,
        schema::VERTEX,
    ] {
        let expected = source.get(&kind).copied().unwrap_or(0);
        let actual = output.get(&kind).copied().unwrap_or(0);
        if expected != actual {
            findings.insert(format!("entity-count-{kind}-{expected}-to-{actual}"), 1);
        }
    }
    findings
}

#[derive(Debug, Default)]
struct SourceCounts {
    bodies: usize,
    faces: usize,
    unique_faces: usize,
    isolated_fins: usize,
}

fn source_counts(entities: &[RawEntity]) -> SourceCounts {
    SourceCounts {
        bodies: entities
            .iter()
            .filter(|entity| entity.type_id == schema::BODY)
            .count(),
        faces: entities
            .iter()
            .filter(|entity| entity.type_id == schema::FACE)
            .count(),
        unique_faces: entities
            .iter()
            .filter(|entity| entity.type_id == schema::FACE)
            .map(|entity| entity.index)
            .collect::<BTreeSet<_>>()
            .len(),
        isolated_fins: 0,
    }
}

fn audit(path: &Path) -> Result<(BTreeMap<String, usize>, SourceCounts), String> {
    if std::fs::metadata(path).map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("file byte budget exceeded".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    // A reversible byte view permits inspection; it does not certify text encoding.
    #[cfg(not(audit_parser_v3))]
    let text = String::from_utf8(bytes)
        .unwrap_or_else(|error| error.into_bytes().into_iter().map(char::from).collect());
    #[cfg(audit_parser_v3)]
    let text = xt_parser::decode(bytes);
    let (_, body_text) = xt_parser::header::split_header(&text).map_err(|e| e.to_string())?;
    #[cfg(not(audit_parser_v3))]
    let (_, _, stream) = schema::parse_tline(body_text).map_err(|e| e.to_string())?;
    #[cfg(audit_parser_v3)]
    let tline = schema::parse_tline(body_text).map_err(|e| e.to_string())?;
    #[cfg(audit_parser_v3)]
    let stream = tline.body;
    let mut remaining = stream.as_str();
    #[cfg(not(audit_parser_v3))]
    let preamble = schema::parse_schema_preamble(&mut remaining).map_err(|e| e.to_string())?;
    #[cfg(not(audit_parser_v3))]
    let entities = xt_parser::entity::parse_entities(&mut remaining, preamble.partition_count)
        .map_err(|e| e.to_string())?;
    #[cfg(audit_parser_v3)]
    let entities = {
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
        if let Some(reason) = truncated {
            return Err(reason.to_string());
        }
        entities
    };
    let bodies = xt_parser::build::build_bodies(&entities).map_err(|e| e.to_string())?;
    #[cfg(audit_parser_v3)]
    let isolated = isolated_fin_witnesses(&entities, |e| entities.fields(e));
    #[cfg(not(audit_parser_v3))]
    let isolated = isolated_fin_witnesses(&entities, |e| &e.fields);
    let mut findings = graph_findings(&entities, &bodies, &isolated);
    if !remaining.trim().is_empty() {
        findings.insert("unconsumed-stream-bytes".into(), remaining.len());
    }
    if bodies.is_empty() {
        findings.insert("no-bodies".into(), 1);
    }
    let mut counts = source_counts(&entities);
    counts.isolated_fins = isolated.len();
    Ok((findings, counts))
}

fn run() -> Result<(), String> {
    let root = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("usage: xt-parser-audit <corpus>")?,
    );
    let mut files = Vec::new();
    collect(&root, &mut files)?;
    files.sort();
    if files.is_empty() {
        return Err("no X_T files found".into());
    }
    let mut totals = BTreeMap::<&str, usize>::new();
    for path in files {
        let (status, detail, counts) = match std::panic::catch_unwind(|| audit(&path)) {
            Ok(Ok((findings, counts))) => (
                if findings.is_empty() {
                    "audit-clear-unverified"
                } else {
                    "incomplete"
                },
                format!("{findings:?}"),
                Some(counts),
            ),
            Ok(Err(error)) => ("parse-error", error, None),
            Err(_) => ("panic", "parser panic".into(), None),
        };
        *totals.entry(status).or_default() += 1;
        let counts = counts.map_or_else(
            || "null".into(),
            |counts| {
                format!(
                    "{{\"bodies\":{},\"faces\":{},\"uniqueFaces\":{},\"isolatedFins\":{}}}",
                    counts.bodies, counts.faces, counts.unique_faces, counts.isolated_fins,
                )
            },
        );
        println!(
            "{status}\t{:?}\t{detail:?}\t{counts}",
            path.strip_prefix(&root).unwrap_or(&path)
        );
    }
    println!("TOTAL\t{totals:?}");
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod shared_tests {
    use super::*;

    fn empty_solid() -> XtBody {
        XtBody {
            node_id: 1,
            body_type: XtBodyType::Solid,
            res_size: 1000.0,
            res_linear: 1e-6,
            regions: vec![],
            shells: vec![],
            surfaces: Default::default(),
            curves: Default::default(),
            points: Default::default(),
            vertices: Default::default(),
            edges: Default::default(),
        }
    }

    #[test]
    fn solid_without_shell_is_visible_in_both_parser_variants() {
        assert_eq!(
            graph_findings(&[], &[empty_solid()], &BTreeSet::new()).get("solid-without-shell"),
            Some(&1)
        );
    }

    #[test]
    fn dangling_vertex_point_is_a_distinct_finding() {
        let mut body = empty_solid();
        body.vertices.insert(
            9,
            xt_parser::XtVertex {
                node_id: 9,
                point_key: 42,
                tolerance: 0.0,
            },
        );
        assert_eq!(
            graph_findings(&[], &[body], &BTreeSet::new()).get("missing-vertex-point"),
            Some(&1)
        );
    }

    #[test]
    fn isolated_raw_witness_requires_every_link_and_a_real_vertex() {
        let links = [2, 3, 3, 4, 0, 0, 0];
        assert!(isolated_links(3, links, true));
        assert!(!isolated_links(3, links, false));
        for slot in 1..7 {
            let mut invalid = links;
            invalid[slot] = if slot < 4 { 0 } else { 9 };
            assert!(!isolated_links(3, invalid, true), "slot {slot}");
        }
    }

    #[test]
    fn only_matching_zero_edge_with_one_raw_witness_is_informational() {
        use xt_parser::{XtFace, XtFin, XtLoop, XtLoopKind, XtSense, XtShell, XtVertex};
        let mut body = empty_solid();
        body.vertices.insert(
            4,
            XtVertex {
                node_id: 4,
                point_key: 5,
                tolerance: 0.0,
            },
        );
        body.points.insert(5, [0.0; 3]);
        body.shells.push(XtShell {
            faces: vec![XtFace {
                node_id: 7,
                tolerance: 0.0,
                surface_key: 6,
                sense: XtSense::Forward,
                loops: vec![XtLoop {
                    kind: XtLoopKind::Unknown,
                    fins: vec![XtFin {
                        edge_key: 0,
                        vertex_key: Some(4),
                        sense: XtSense::Forward,
                        pcurve_key: None,
                    }],
                }],
            }],
        });
        let witness = BTreeSet::from([(7, 4)]);
        assert!(!graph_findings(&[], &[body.clone()], &witness).contains_key("missing-fin-edge"));
        assert_eq!(
            graph_findings(&[], &[body.clone()], &BTreeSet::new()).get("missing-fin-edge"),
            Some(&1)
        );
        let lp = body.shells[0].faces[0].loops[0].clone();
        body.shells[0].faces[0].loops.push(lp);
        assert_eq!(
            graph_findings(&[], &[body.clone()], &witness).get("missing-fin-edge"),
            Some(&1)
        );
        body.shells[0].faces[0].loops.truncate(1);
        body.shells[0].faces[0].loops[0].fins[0].edge_key = 999;
        assert_eq!(
            graph_findings(&[], &[body], &witness).get("missing-fin-edge"),
            Some(&1)
        );
    }
}

#[cfg(all(test, not(audit_parser_v3)))]
mod tests {
    use super::*;

    fn entity(kind: u16, index: usize) -> RawEntity {
        RawEntity {
            type_id: kind,
            index,
            fields: vec![],
            var_f64: vec![],
            var_i16: vec![],
            var_i32: vec![],
            var_ptr: vec![],
            var_char: vec![],
        }
    }

    #[test]
    fn catches_lost_faces_even_when_no_error_was_returned() {
        let result = graph_findings(&[entity(schema::FACE, 7)], &[], &BTreeSet::new());
        assert_eq!(result.get("entity-count-14-1-to-0"), Some(&1));
    }

    #[test]
    fn duplicate_identity_is_distinct_from_count_loss() {
        let result = graph_findings(
            &[entity(schema::FACE, 7), entity(schema::FACE, 7)],
            &[],
            &BTreeSet::new(),
        );
        assert_eq!(result.get("duplicate-type-index"), Some(&1));
        assert!(result.contains_key("entity-count-14-2-to-0"));
        let counts = source_counts(&[
            entity(schema::FACE, 7),
            entity(schema::FACE, 7),
            entity(schema::BODY, 1),
        ]);
        assert_eq!(
            (counts.bodies, counts.faces, counts.unique_faces),
            (1, 2, 1)
        );
    }
}
