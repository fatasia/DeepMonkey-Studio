use std::collections::BTreeSet;

fn main() {
    let paths: Vec<_> = std::env::args().skip(1).collect();
    assert!(!paths.is_empty(), "expected at least one X_T sample path");
    for path in paths {
        let bytes = std::fs::read(&path).expect("sample");
        let parsed = xt_parser::parse_raw(&xt_parser::decode(bytes)).expect("parse");
        assert!(parsed.truncated.is_none(), "incomplete source stream");
        let raw: BTreeSet<_> = parsed.entities.iter()
            .filter(|e| e.type_id == xt_parser::schema::FACE).map(|e| e.index).collect();
        let bodies = cad_xt::topo::lower_bodies(&parsed.entities, 1e-8);
        let mut mapped = BTreeSet::new();
        for body in &bodies {
            for skipped in &body.skipped {
                eprintln!("diagnostic body={} entity={} {}", body.body_handle, skipped.entity, skipped.reason);
            }
            assert_eq!(body.face_sources.len(), body.solid.faces.len());
            for (face_id, source) in body.face_sources.iter().enumerate() {
                assert!(mapped.insert(*source), "duplicate source face {source}");
                assert!(body.solid.shells.iter().any(|shell|
                    shell.faces.iter().any(|id| id.0 as usize == face_id)), "unowned FaceId");
                println!("map body={} FaceId={} source={source}", body.body_handle, face_id);
            }
        }
        assert_eq!(mapped, raw, "raw source face identity mismatch");
        println!("verified {} bodies={} unique_source_faces={}", path, bodies.len(), mapped.len());
    }
}
