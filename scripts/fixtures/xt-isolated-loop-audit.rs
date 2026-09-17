use std::path::Path;
use xt_parser::entity::{Entities, RawEntity, FieldVal};
use xt_parser::schema as xt;

fn pointer(entities: &Entities, entity: &RawEntity, slot: usize) -> usize {
    match entities.fields(entity).get(slot) {
        Some(FieldVal::Ptr(value)) => *value,
        _ => panic!("invalid pointer {}:{slot}", entity.index),
    }
}

fn analyze(path: &Path, totals: &mut [usize; 4]) {
    if path.is_dir() {
        for entry in std::fs::read_dir(path).unwrap() { analyze(&entry.unwrap().path(), totals); }
        return;
    }
    if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("x_t")) { return; }
    let file = xt_parser::parse_raw(&xt_parser::decode(std::fs::read(path).unwrap())).unwrap();
    assert!(file.truncated.is_none());
    let entities = &file.entities;
    let index: std::collections::BTreeMap<_,_> = entities.iter().map(|e| (e.index, e)).collect();
    let mut expected = Vec::new();
    for fin in entities.iter().filter(|e| e.type_id == xt::FIN) {
        let shift = usize::from(entities.fields(fin).len() == 9);
        if pointer(entities, fin, 6 - shift) != 0 { continue; }
        assert_eq!(pointer(entities, fin, 2 - shift), fin.index);
        assert_eq!(pointer(entities, fin, 3 - shift), fin.index);
        assert_eq!(pointer(entities, fin, 5 - shift), 0);
        assert_eq!(pointer(entities, fin, 7 - shift), 0);
        let lp = index[&pointer(entities, fin, 1 - shift)];
        assert_eq!(lp.type_id, xt::LOOP);
        let vertex = index[&pointer(entities, fin, 4 - shift)];
        assert_eq!(vertex.type_id, xt::VERTEX);
        let point = index[&pointer(entities, vertex, 5)];
        assert_eq!(point.type_id, xt::POINT);
        let FieldVal::Vec3(position) = &entities.fields(point)[5] else { panic!("missing position") };
        expected.push((pointer(entities, lp, 3), position.map(f64::to_bits)));
    }
    let bodies = cad_xt::topo::lower_bodies(entities, 1e-8);
    let mut actual = Vec::new();
    let skipped: usize = bodies.iter().map(|b| b.skipped.len()).sum();
    for body in &bodies {
        for (id, face) in body.solid.faces.iter().enumerate() {
            for bound in &face.bounds {
                if let Some(vertex) = bound.vertex {
                    assert!(bound.halves.is_empty(), "point bound has fabricated edges");
                    actual.push((body.face_sources[id], body.solid.vertex(vertex).to_array().map(f64::to_bits)));
                }
            }
        }
    }
    expected.sort_unstable(); actual.sort_unstable();
    assert_eq!(actual, expected, "isolated loop source mismatch: {}", path.display());
    println!("{} point_bounds={} skipped={skipped}", path.display(), actual.len());
    totals[0] += 1; totals[1] += expected.len(); totals[2] += actual.len(); totals[3] += skipped;
}

fn main() {
    let roots: Vec<_> = std::env::args().skip(1).collect();
    assert!(!roots.is_empty(), "expected X_T samples or corpus directory");
    let mut totals = [0; 4];
    for root in roots { analyze(Path::new(&root), &mut totals); }
    assert!(totals[0] > 0, "no X_T samples audited");
    println!("files/source-point-loops/lowered-point-bounds/skipped={totals:?}");
}
