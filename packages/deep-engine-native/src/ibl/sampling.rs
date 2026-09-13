pub fn hammersley(index: u32, count: u32) -> [f32; 2] {
    [
        index as f32 / count as f32,
        index.reverse_bits() as f32 * 2.328_306_4e-10,
    ]
}

pub fn cube_direction(face: u32, x: u32, y: u32, size: u32) -> [f32; 3] {
    let u = (x as f32 + 0.5) / size as f32 * 2.0 - 1.0;
    let v = (y as f32 + 0.5) / size as f32 * 2.0 - 1.0;
    normalize(match face {
        0 => [1.0, -v, -u],
        1 => [-1.0, -v, u],
        2 => [u, 1.0, v],
        3 => [u, -1.0, -v],
        4 => [u, -v, 1.0],
        _ => [-u, -v, -1.0],
    })
}

pub fn studio(direction: [f32; 3]) -> [f32; 3] {
    let sky_mix = smoothstep(-0.3, 0.9, direction[1]);
    let mut color = mix([0.025, 0.03, 0.04], [0.20, 0.24, 0.30], sky_mix);
    for (center, width, height, radiance) in [
        ([-1.0, 1.5, 1.0], 0.7, 0.35, [5.0, 4.8, 4.4]),
        ([1.0, 0.65, -1.0], 0.20, 0.8, [2.8, 3.4, 4.2]),
        ([0.3, 1.8, -0.5], 0.8, 0.3, [1.3, 1.5, 1.8]),
    ] {
        color = add(
            color,
            mul(radiance, softbox(direction, center, width, height)),
        );
    }
    color
}

pub fn ggx(xi: [f32; 2], roughness: f32) -> [f32; 3] {
    let alpha = roughness * roughness;
    let cosine = ((1.0 - xi[1]) / (1.0 + (alpha * alpha - 1.0) * xi[1]).max(0.00001)).sqrt();
    let sine = (1.0 - cosine * cosine).max(0.0).sqrt();
    [
        (std::f32::consts::TAU * xi[0]).cos() * sine,
        (std::f32::consts::TAU * xi[0]).sin() * sine,
        cosine,
    ]
}

pub fn basis(normal: [f32; 3], direction: [f32; 3]) -> [f32; 3] {
    let up = if normal[1].abs() > 0.99 {
        [1.0, 0.0, 0.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    let tangent = normalize(cross(up, normal));
    let bitangent = cross(normal, tangent);
    normalize(add(
        add(mul(tangent, direction[0]), mul(bitangent, direction[1])),
        mul(normal, direction[2]),
    ))
}

pub fn reflect(vector: [f32; 3], normal: [f32; 3]) -> [f32; 3] {
    add(vector, mul(normal, -2.0 * dot(vector, normal)))
}

pub fn normalize(value: [f32; 3]) -> [f32; 3] {
    mul(value, 1.0 / dot(value, value).sqrt().max(0.000001))
}

pub fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub fn add(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub fn mul(value: [f32; 3], scale: f32) -> [f32; 3] {
    [value[0] * scale, value[1] * scale, value[2] * scale]
}

fn mix(a: [f32; 3], b: [f32; 3], amount: f32) -> [f32; 3] {
    add(mul(a, 1.0 - amount), mul(b, amount))
}

fn smoothstep(start: f32, end: f32, value: f32) -> f32 {
    let value = ((value - start) / (end - start)).clamp(0.0, 1.0);
    value * value * (3.0 - 2.0 * value)
}

fn softbox(direction: [f32; 3], center: [f32; 3], width: f32, height: f32) -> f32 {
    let normal = normalize(center);
    let right = normalize(cross([0.0, 1.0, 0.0], normal));
    let up = cross(normal, right);
    let forward = dot(direction, normal);
    let point = [
        dot(direction, right) / forward.max(0.001),
        dot(direction, up) / forward.max(0.001),
    ];
    let edge = (point[0].abs() / width).max(point[1].abs() / height);
    (1.0 - smoothstep(0.88, 1.0, edge)) * if forward >= 0.0 { 1.0 } else { 0.0 }
}
