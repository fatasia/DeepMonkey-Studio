//! Requires the pinned local AS, AT-2810R corpus; run with XT_ADJACENT_SOURCE.
pub use cad_xt::geom;
#[path = "../../data/external-assets/format-research/cadconvert/native/crates/cad-xt/src/adjacent_intersection.rs"]
mod adjacent_intersection;

#[test]
fn actual_extended_support_recovers_both_sides_and_rejects_bad_inputs() {
    use cad_ir::Vec3;
    let source = std::env::var("XT_ADJACENT_SOURCE").expect("set pinned real X_T source");
    let bytes = std::fs::read(source).unwrap();
    let file = xt_parser::parse_raw(&xt_parser::decode(bytes)).unwrap();
    assert!(file.truncated.is_none());
    let e = &file.entities;
    let index: geom::Index = e.iter().map(|r| (r.index, r)).collect();
    let curve = geom::curve(e, index[&675], &index).unwrap();
    let endpoints: Vec<_> = e.fields(index[&675])[8..10].iter().map(|f| {
        let p = f.as_vec3(); Vec3::new(p[0],p[1],p[2])
    }).collect();
    let (from,to) = (endpoints[0],endpoints[1]);
    let range = curve.natural_range();
    let recover = |edge,a,b,tolerance| adjacent_intersection::recover(e,&index,edge,&curve,range,a,b,tolerance);
    let fine = recover(665,from,to,1e-5).expect("source-authored extended surface must recover");
    let surfaces = [431,376].map(|id|geom::surface(e,index[&id],&index).unwrap());
    assert!((fine.point_at(fine.natural_range().lo)-from).length()<1e-12);
    assert!((fine.point_at(fine.natural_range().hi)-to).length()<1e-12);
    for i in 0..=1024 {
        let p = fine.point_at(fine.natural_range().at(i as f64/1024.));
        for s in &surfaces {assert!((s.point_at(s.invert(p,None).unwrap())-p).length()<=1e-5);}
    }
    assert!(recover(675,from,to,1e-5).is_none(),"curve is not an edge");
    assert!(recover(665,from,to+Vec3::new(0.,0.,0.01),1e-5).is_none(),"wrong endpoint");
    assert!(recover(665,from,from,1e-5).is_none(),"closed ambiguity");
    for tolerance in [0.,-1.,f64::NAN,f64::INFINITY] {assert!(recover(665,from,to,tolerance).is_none());}
    let mut missing_partner=index.clone(); missing_partner.remove(&330);
    assert!(adjacent_intersection::recover(e,&missing_partner,665,&curve,range,from,to,1e-5).is_none());
    let mut wrong_support=index.clone(); wrong_support.insert(376,index[&36]);
    assert!(adjacent_intersection::recover(e,&wrong_support,665,&curve,range,from,to,1e-5).is_none());
}
