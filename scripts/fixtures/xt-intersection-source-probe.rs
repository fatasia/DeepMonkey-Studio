//! Diagnostic of source surface inversion; not an independent geometry oracle.
use cad_ir::brep::{NurbsSurface, Surface};
use cad_ir::eval::nurbs::de_boor;
use cad_ir::{Vec2, Vec3};

fn continued(n: &NurbsSurface, uv: Vec2) -> Vec3 {
    assert!(
        n.weights.is_empty(),
        "diagnostic only covers polynomial surfaces"
    );
    let rows: Vec<_> = n
        .control_points
        .iter()
        .map(|row| {
            let points: Vec<_> = row.iter().map(|p| p.to_array()).collect();
            de_boor(n.v_degree, &points, &n.v_knots, uv.v)
        })
        .collect();
    let p = de_boor(n.u_degree, &rows, &n.u_knots, uv.u);
    Vec3::new(p[0], p[1], p[2])
}

fn continuation_probe(n: &NurbsSurface, p: Vec3, mut uv: Vec2) -> (f64, Vec2) {
    for _ in 0..40 {
        let at = continued(n, uv);
        let du = (continued(n, Vec2::new(uv.u + 1e-6, uv.v))
            - continued(n, Vec2::new(uv.u - 1e-6, uv.v)))
            * 5e5;
        let dv = (continued(n, Vec2::new(uv.u, uv.v + 1e-6))
            - continued(n, Vec2::new(uv.u, uv.v - 1e-6)))
            * 5e5;
        let (a, b, c) = (du.dot(du), du.dot(dv), dv.dot(dv));
        let determinant = a * c - b * b;
        if determinant.abs() < 1e-30 {
            break;
        }
        let difference = p - at;
        let (e, f) = (difference.dot(du), difference.dot(dv));
        let step = Vec2::new((e * c - f * b) / determinant, (f * a - e * b) / determinant);
        uv = uv + step;
        if step.u.abs() + step.v.abs() < 1e-12 {
            break;
        }
    }
    ((continued(n, uv) - p).length(), uv)
}
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    assert!((3..=4).contains(&args.len()), "file intersection chart-curve [diagnostic-second-support]");
    let bytes = std::fs::read(&args[0]).unwrap();
    let file = xt_parser::parse_raw(&xt_parser::decode(bytes)).unwrap();
    assert!(file.truncated.is_none());
    let entities = &file.entities;
    let index: cad_xt::geom::Index = entities.iter().map(|e| (e.index, e)).collect();
    let intersection = index[&args[1].parse::<usize>().unwrap()];
    let first = entities.fields(intersection)[7].as_ptr();
    let declared_second = entities.extra(intersection)[0].as_ptr();
    let second = args.get(3).map(|v| v.parse::<usize>().unwrap()).unwrap_or(declared_second);
    println!("declared-second-support={declared_second}; diagnostic-second-support={second}");
    let curve =
        cad_xt::geom::curve(entities, index[&args[2].parse::<usize>().unwrap()], &index).unwrap();
    let trimmed = index[&args[2].parse::<usize>().unwrap()];
    let endpoints: Vec<_> = if trimmed.type_id == xt_parser::schema::TRIMMED_CURVE {
        entities.fields(trimmed)[8..10]
            .iter()
            .map(|f| {
                let p = f.as_vec3();
                Vec3::new(p[0], p[1], p[2])
            })
            .collect()
    } else {
        vec![]
    };
    for e in entities
        .iter()
        .filter(|e| [xt_parser::schema::EDGE, xt_parser::schema::FIN].contains(&e.type_id))
    {
        let fields = entities.fields(e);
        if fields
            .iter()
            .any(|f| f.as_ptr() == args[2].parse::<usize>().unwrap())
        {
            println!("owner {} type {}: {fields:?}", e.index, e.type_id);
        }
    }
    for id in [first, second] {
        let s = cad_xt::geom::surface(entities, index[&id], &index).unwrap();
        println!("surface {id}: {s:?}");
        if let Surface::Nurbs(n) = &s {
            let mut bounds = cad_ir::math::Aabb::EMPTY;
            for row in &n.control_points {
                for p in row {
                    bounds.add_point(*p);
                }
            }
            println!(
                "controlBounds: {bounds:?}; positive-weight-convex-hull={}",
                n.weights.is_empty()
                    || n.weights
                        .iter()
                        .flatten()
                        .all(|w| w.is_finite() && *w > 0.0)
            );
            for (i, p) in endpoints.iter().enumerate() {
                let uv = s.invert(*p, None).unwrap();
                println!(
                    "trimmedEndpoint {i}: p={p:?} uv={uv:?} residual={:e} continuation={:?}",
                    (s.point_at(uv) - *p).length(),
                    continuation_probe(n, *p, uv)
                );
            }
        }
        let d = s.domain();
        for i in 0..=16 {
            let p = curve.point_at(curve.natural_range().at(i as f64 / 16.0));
            let uv = s.invert(p, None).unwrap();
            let off = (p - s.point_at(uv)).length();
            let mut best = (off, uv);
            if id == second {
                for u in 0..=20 {
                    for v in 0..=20 {
                        let seed = Vec2::new(d.u.at(u as f64 / 20.0), d.v.at(v as f64 / 20.0));
                        if let Some(q) = s.invert_near(p, seed, 1e-7) {
                            let miss = (p - s.point_at(q)).length();
                            if miss < best.0 {
                                best = (miss, q);
                            }
                        }
                    }
                }
            }
            println!("{i}: p={p:?} uv={uv:?} residual={off:e} best={best:?}");
            if let Surface::Nurbs(n) = &s {
                println!("continuation {i}: {:?}", continuation_probe(n, p, uv));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn continuation_is_a_negative_control_not_a_clamped_surface() {
        let n = NurbsSurface {
            u_degree: 1,
            v_degree: 1,
            control_points: vec![vec![Vec3::ZERO, Vec3::Y], vec![Vec3::X, Vec3::X + Vec3::Y]],
            weights: vec![],
            u_knots: vec![0., 0., 1., 1.],
            v_knots: vec![0., 0., 1., 1.],
            u_closed: false,
            v_closed: false,
        };
        let p = Vec3::new(2., -1., 0.);
        let surface = Surface::Nurbs(n.clone());
        let uv = surface.invert(p, None).unwrap();
        assert!((surface.point_at(uv) - p).length() > 1.);
        let (error, extended) = continuation_probe(&n, p, uv);
        assert!(error < 1e-10);
        assert!((extended.u - 2.).abs() < 1e-10 && (extended.v + 1.).abs() < 1e-10);
    }
}
