// DeepMonkey 渲染基准 Unity 档:与 apps/web/benchmarks/render-engine/src/fixture.ts 同一布局合约。
// 帧间隔在帧尾用 Time.realtimeSinceStartup 采样(vSyncCount=1,与浏览器 rAF 同为刷新节拍)。
using System;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEngine;

public class BenchRunner : MonoBehaviour
{
    static int frames = 600;
    static string workload = "static";
    static int objectCount = 120;
    static string outPath = "frame-times.json";

    static readonly string[] Kinds = { "box", "sphere", "cylinder", "cone", "torus", "capsule" };
    static readonly Color[] Colors = {
        new Color(0xd6 / 255f, 0xa9 / 255f, 0x4c / 255f),
        new Color(0x54 / 255f, 0xa9 / 255f, 0x94 / 255f),
        new Color(0x55 / 255f, 0x7f / 255f, 0x9f / 255f),
        new Color(0xc8 / 255f, 0x6f / 255f, 0x63 / 255f),
        new Color(0x81 / 255f, 0x70 / 255f, 0xaa / 255f),
        new Color(0x84 / 255f, 0x90 / 255f, 0x59 / 255f),
    };

    float[] samples;
    int recorded;
    int warmupLeft = 120;
    bool lastSet;
    float last;
    Transform[] placed;
    float[] baseY;

    void Awake()
    {
        var args = Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length; i++)
        {
            if ((args[i] == "-frames" || args[i] == "--frames") && i + 1 < args.Length) frames = int.Parse(args[i + 1], CultureInfo.InvariantCulture);
            else if ((args[i] == "-workload" || args[i] == "--workload") && i + 1 < args.Length) workload = args[i + 1];
            else if ((args[i] == "-count" || args[i] == "--count") && i + 1 < args.Length) objectCount = int.Parse(args[i + 1], CultureInfo.InvariantCulture);
            else if ((args[i] == "-out" || args[i] == "--out") && i + 1 < args.Length) outPath = args[i + 1];
        }
        QualitySettings.vSyncCount = 1;
        Application.targetFrameRate = -1;
        Application.runInBackground = true;
        BuildScene();
        samples = new float[frames];
    }

    float CameraDistance()
    {
        float columns = Mathf.Ceil(Mathf.Sqrt(objectCount * 1.2f));
        return Mathf.Max(19f, Mathf.CeilToInt(columns * 1.55f));
    }

    void BuildScene()
    {
        var cameraGo = new GameObject("BenchCamera");
        var camera = cameraGo.AddComponent<Camera>();
        camera.tag = "MainCamera";
        float distance = CameraDistance();
        cameraGo.transform.position = new Vector3(distance, distance * 0.72f, distance);
        cameraGo.transform.LookAt(new Vector3(0f, 1.8f, 0f));
        camera.fieldOfView = 48f;
        camera.nearClipPlane = 0.1f;
        camera.farClipPlane = 5000f;
        camera.backgroundColor = new Color(0x11 / 255f, 0x19 / 255f, 0x1d / 255f);
        camera.clearFlags = CameraClearFlags.SolidColor;

        var sunGo = new GameObject("BenchSun");
        sunGo.transform.position = new Vector3(18f, 28f, 12f);
        sunGo.transform.rotation = Quaternion.LookRotation(new Vector3(-18f, -28f, -12f).normalized, Vector3.up);
        var sun = sunGo.AddComponent<Light>();
        sun.type = LightType.Directional;
        sun.color = Color.white;
        sun.intensity = 1f;
        sun.shadows = LightShadows.Soft;

        RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat;
        RenderSettings.ambientLight = new Color(0xbd / 255f, 0xdc / 255f, 0xff / 255f) * 0.35f;

        var ground = GameObject.CreatePrimitive(PrimitiveType.Plane);
        ground.name = "ground";
        float size = CameraDistance() * 3f;
        ground.transform.localScale = new Vector3(size / 10f, 1f, size / 10f); // Unity Plane 默认 10×10
        var groundLoaded = Resources.Load<Material>("bench-ground");
        ground.GetComponent<Renderer>().material = groundLoaded ? groundLoaded : MakeMaterial(new Color(0x20 / 255f, 0x2a / 255f, 0x2e / 255f), 0.94f);

        placed = new Transform[objectCount];
        baseY = new float[objectCount];
        int columns = Mathf.CeilToInt(Mathf.Sqrt(objectCount * 1.2f));
        int rows = Mathf.CeilToInt(objectCount / (float)columns);
        var materials = new Material[Colors.Length];
        for (int c = 0; c < Colors.Length; c++) materials[c] = LoadOrBuildMaterial(c);

        for (int index = 0; index < objectCount; index++)
        {
            string kind = Kinds[index % Kinds.Length];
            var go = MakePrimitive(kind);
            go.name = $"fixture-{index:D4}";
            float x = (index % columns - (columns - 1) / 2f) * 1.8f;
            float z = (Mathf.FloorToInt(index / (float)columns) - (rows - 1) / 2f) * 1.8f;
            float y = GroundOffset(kind);
            go.transform.position = new Vector3(x, y, z);
            go.transform.rotation = Quaternion.Euler(0f, index * 0.17f, 0f);
            var fx = 0.55f; var fy = 0.55f + index % 4 * 0.08f; // fixture.ts 的逐轴缩放
            var b = BaseScale(kind);
            go.transform.localScale = new Vector3(b.x * fx, b.y * fy, b.z * fx);
            go.GetComponent<Renderer>().material = materials[(index) % Colors.Length];
            placed[index] = go.transform;
            baseY[index] = y;
        }
    }

    Material MakeMaterial(Color color, float smoothness)
    {
        var material = new Material(Shader.Find("Standard"));
        material.color = color;
        material.SetFloat("_Glossiness", 1f - smoothness); // Standard: smoothness=1-roughness
        material.SetFloat("_Metallic", 0.05f);
        return material;
    }

    // 构建期由 BenchBuild 调用(Editor 侧 Shader.Find 可用),资产存 Resources 保证进包
    public static Material CreateBenchMaterial(int colorIndex)
    {
        var material = new Material(Shader.Find("Standard"));
        material.color = Colors[colorIndex];
        material.SetFloat("_Glossiness", 1f - 0.72f);
        material.SetFloat("_Metallic", 0.05f);
        return material;
    }

    public static Material CreateGroundMaterial()
    {
        var material = new Material(Shader.Find("Standard"));
        material.color = new Color(0x20 / 255f, 0x2a / 255f, 0x2e / 255f);
        material.SetFloat("_Glossiness", 1f - 0.94f);
        material.SetFloat("_Metallic", 0f);
        return material;
    }

    Material LoadOrBuildMaterial(int colorIndex)
    {
        var loaded = Resources.Load<Material>($"bench-mat-{colorIndex}");
        return loaded ? loaded : MakeMaterial(Colors[colorIndex], 0.72f);
    }

    GameObject MakePrimitive(string kind)
    {
        if (kind == "cone") { var go = new GameObject(kind); go.AddComponent<MeshFilter>().sharedMesh = ConeMesh(); go.AddComponent<MeshRenderer>(); return go; }
        if (kind == "torus") { var go = new GameObject(kind); go.AddComponent<MeshFilter>().sharedMesh = TorusMesh(); go.AddComponent<MeshRenderer>(); return go; }
        var primitive = GameObject.CreatePrimitive(
            kind == "sphere" ? PrimitiveType.Sphere :
            kind == "cylinder" ? PrimitiveType.Cylinder :
            kind == "capsule" ? PrimitiveType.Capsule : PrimitiveType.Cube);
        // 保留默认 Collider(无刚体时不参与模拟、无渲染成本;零依赖 manifest 不含 Physics 模块)
        return primitive;
    }

    // three 几何基尺寸 → Unity 原生/自建网格的等价基缩放(fixture 缩放另行逐轴相乘)
    Vector3 BaseScale(string kind) => kind switch {
        "sphere" => new Vector3(2f, 2f, 2f),      // Unity 球 d1,three r1 → d2
        "cylinder" => new Vector3(2f, 1f, 2f),    // Unity 柱 d1 h2,three d2 h2
        "capsule" => new Vector3(1.3f, 1.35f, 1.3f), // Unity 胶囊 d0.5 h2,three r0.65 h2.7
        "box" => new Vector3(2f, 2f, 2f),          // Unity 立方 1³,three box 2³
        _ => Vector3.one,                          // cone/torus 自建网格已按 three 尺寸
    };

    float GroundOffset(string kind) => kind == "torus" ? 0.35f : kind == "capsule" ? 1.35f : 1f;

    Mesh ConeMesh()
    {
        var mesh = new Mesh();
        const int segments = 32;
        var vertices = new Vector3[segments + 1 + 1];
        vertices[0] = new Vector3(0f, 1f, 0f);
        for (int i = 0; i < segments; i++)
        {
            float a = i / (float)segments * Mathf.PI * 2f;
            vertices[i + 1] = new Vector3(Mathf.Cos(a), -1f, Mathf.Sin(a));
        }
        vertices[segments + 1] = new Vector3(0f, -1f, 0f);
        var triangles = new int[segments * 2 * 3];
        for (int i = 0; i < segments; i++)
        {
            int next = (i + 1) % segments + 1;
            int current = i + 1;
            triangles[i * 6] = 0; triangles[i * 6 + 1] = current; triangles[i * 6 + 2] = next;
            triangles[i * 6 + 3] = segments + 1; triangles[i * 6 + 4] = next; triangles[i * 6 + 5] = current;
        }
        mesh.vertices = vertices; mesh.triangles = triangles; mesh.RecalculateNormals();
        // three ConeGeometry(1,2,32):高 2 底半径 1 → 本体单位高 2,用缩放补齐
        return mesh;
    }

    Mesh TorusMesh()
    {
        var mesh = new Mesh();
        const int radial = 18, tubular = 48;
        const float radius = 1f, tube = 0.32f;
        var vertices = new Vector3[(radial + 1) * (tubular + 1)];
        var normals = new Vector3[vertices.Length];
        for (int j = 0; j <= radial; j++)
        {
            float u = j / (float)radial * Mathf.PI * 2f;
            var center = new Vector3(radius * Mathf.Cos(u), 0f, radius * Mathf.Sin(u));
            for (int i = 0; i <= tubular; i++)
            {
                float v = i / (float)tubular * Mathf.PI * 2f;
                float cosV = Mathf.Cos(v), sinV = Mathf.Sin(v);
                var normal = new Vector3(cosV * Mathf.Cos(u), sinV, cosV * Mathf.Sin(u));
                vertices[j * (tubular + 1) + i] = center + new Vector3(normal.x, 0f, normal.z) * tube + Vector3.up * (normal.y * tube);
                normals[j * (tubular + 1) + i] = normal;
            }
        }
        var triangles = new int[radial * tubular * 6];
        int t = 0;
        for (int j = 1; j <= radial; j++)
            for (int i = 1; i <= tubular; i++)
            {
                int a = (radial + 1) * (j - 1) + (i - 1);
                int b = (radial + 1) * (j - 1) + i;
                int c = (radial + 1) * j + i;
                int d = (radial + 1) * j + (i - 1);
                triangles[t++] = a; triangles[t++] = b; triangles[t++] = d;
                triangles[t++] = b; triangles[t++] = c; triangles[t++] = d;
            }
        mesh.vertices = vertices; mesh.normals = normals; mesh.triangles = triangles;
        return mesh;
    }

    void LateUpdate()
    {
        if (workload == "dynamic")
        {
            int movingCount = Mathf.Min(200, placed.Length);
            for (int index = 0; index < movingCount; index++)
            {
                var transform = placed[index];
                transform.rotation = Quaternion.Euler(0f, transform.rotation.eulerAngles.y + (0.004f + index % 5 * 0.0004f) * Mathf.Rad2Deg * Time.deltaTime * 16.67f, 0f);
                transform.position = new Vector3(transform.position.x, baseY[index] + Mathf.Sin(Time.realtimeSinceStartup * 1.5f + index) * 0.08f, transform.position.z);
            }
        }
        float now = Time.realtimeSinceStartup;
        if (warmupLeft > 0) { warmupLeft--; last = now; return; }
        if (recorded >= frames) return;
        if (!lastSet) { lastSet = true; last = now; return; }
        samples[recorded] = (now - last) * 1000f;
        last = now;
        recorded++;
        if (recorded == frames) Finish();
    }

    void Finish()
    {
        var builder = new StringBuilder();
        builder.Append("{\"workload\":\"").Append(workload).Append("\",\"objectCount\":").Append(objectCount)
            .Append(",\"frames\":").Append(frames).Append(",\"frameMs\":[");
        for (int i = 0; i < samples.Length; i++)
        {
            if (i > 0) builder.Append(',');
            builder.Append(samples[i].ToString("R", CultureInfo.InvariantCulture));
        }
        builder.Append("]}");
        File.WriteAllText(outPath, builder.ToString(), new UTF8Encoding(false));
        Debug.Log($"[bench] wrote {outPath}");
        Application.Quit();
    }
}
