using Autodesk.Revit.DB;

namespace BimStudio.RevitAddin;

internal static class NativeGlbJobExporter
{
    public static void Export(Document document, string outputDirectory)
    {
        var view = new FilteredElementCollector(document)
            .OfClass(typeof(View3D))
            .Cast<View3D>()
            .FirstOrDefault(candidate => !candidate.IsTemplate);
        if (view is null) throw new InvalidOperationException("RVT 中没有可用于导出的三维视图");

        var context = new RevitGlbExportContext(document);
        var exporter = new CustomExporter(document, context)
        {
            IncludeGeometricObjects = true,
            ShouldStopOnError = false
        };
        exporter.Export(view);
        context.Write(outputDirectory, Path.GetFileNameWithoutExtension(document.PathName));
    }
}

internal sealed class RevitGlbExportContext : IExportContext
{
    private const double FeetToMetres = 0.3048;
    private readonly Document _document;
    private readonly List<ExportElement> _elements = new();
    private readonly Dictionary<string, List<NativeBimParameterMetadata>> _typeParameterCache = new();
    private readonly Dictionary<string, NativeBimMaterialMetadata> _materialCache = new();
    private readonly Stack<Transform> _transforms = new();
    private ExportElement? _currentElement;
    private MaterialStyle _material = MaterialStyle.Default;

    public RevitGlbExportContext(Document document)
    {
        _document = document;
        _transforms.Push(Transform.Identity);
    }

    public bool Start() => true;
    public void Finish() { }
    public bool IsCanceled() => false;
    public RenderNodeAction OnViewBegin(ViewNode node) => RenderNodeAction.Proceed;
    public void OnViewEnd(ElementId elementId) { }

    public RenderNodeAction OnElementBegin(ElementId elementId)
    {
        var element = _document.GetElement(elementId);
        if (element is null) return RenderNodeAction.Skip;
        _currentElement = ExportElement.FromRevit(element, _typeParameterCache, _materialCache);
        _elements.Add(_currentElement);
        return RenderNodeAction.Proceed;
    }

    public void OnElementEnd(ElementId elementId) => _currentElement = null;

    public RenderNodeAction OnInstanceBegin(InstanceNode node)
    {
        _transforms.Push(_transforms.Peek().Multiply(node.GetTransform()));
        return RenderNodeAction.Proceed;
    }

    public void OnInstanceEnd(InstanceNode node)
    {
        if (_transforms.Count > 1) _transforms.Pop();
    }

    public RenderNodeAction OnLinkBegin(LinkNode node)
    {
        _transforms.Push(_transforms.Peek().Multiply(node.GetTransform()));
        return RenderNodeAction.Proceed;
    }

    public void OnLinkEnd(LinkNode node)
    {
        if (_transforms.Count > 1) _transforms.Pop();
    }

    public RenderNodeAction OnFaceBegin(FaceNode node) => RenderNodeAction.Proceed;
    public void OnFaceEnd(FaceNode node) { }
    public void OnRPC(RPCNode node) { }
    public void OnLight(LightNode node) { }

    public void OnMaterial(MaterialNode node)
    {
        var color = node.Color;
        _material = new MaterialStyle(
            color.Red / 255f,
            color.Green / 255f,
            color.Blue / 255f,
            (float)Math.Max(0d, Math.Min(1d, 1d - node.Transparency / 100d)));
    }

    public void OnPolymesh(PolymeshTopology node)
    {
        if (_currentElement is null) return;
        var points = node.GetPoints();
        var transform = _transforms.Peek();
        var mesh = _currentElement.MeshFor(_material);
        foreach (var facet in node.GetFacets())
        {
            var p0 = ToGltf(transform.OfPoint(points[facet.V1]));
            var p1 = ToGltf(transform.OfPoint(points[facet.V2]));
            var p2 = ToGltf(transform.OfPoint(points[facet.V3]));
            var normal = Float3.Normalize(Float3.Cross(p1 - p0, p2 - p0));
            mesh.AddTriangle(p0, p1, p2, normal);
        }
    }

    public void Write(string outputDirectory, string modelName)
    {
        var elements = _elements.Where(element => element.Meshes.Count > 0).ToList();
        GlbWriter.Write(Path.Combine(outputDirectory, "geometry.glb"), modelName, elements);
        var spaces = NativeBimMetadataExtractor.Spaces(_document);
        var model = NativeBimMetadataExtractor.DocumentMetadata(_document, elements, spaces.Count);
        var hierarchy = new
        {
            schemaVersion = 2,
            model,
            root = new
            {
                id = "root",
                name = modelName,
                type = "model",
                children = elements
                    .GroupBy(element => new { Id = element.Metadata.LevelId ?? "unassigned", Name = element.Metadata.Level ?? "未指定楼层" })
                    .OrderBy(group => group.Key.Name)
                    .Select(level => new
                    {
                        id = $"level:{level.Key.Id}",
                        name = level.Key.Name,
                        type = "level",
                        children = level.GroupBy(element => element.Category).OrderBy(group => group.Key).Select(category => new
                        {
                            id = $"level:{level.Key.Id}:category:{category.Key}",
                            name = category.Key,
                            type = "category",
                            children = category.Select(element => new
                            {
                                id = $"element:{element.Id}",
                                elementId = element.Id,
                                element.UniqueId,
                                element.Name,
                                type = element.Category
                            }).ToArray()
                        }).ToArray()
                    }).ToArray()
            },
            spaces = new
            {
                id = "spaces",
                name = "空间",
                type = "spaces",
                children = spaces.Values
                    .GroupBy(space => new { Id = space.LevelId ?? "unassigned", Name = space.Level ?? "未指定楼层" })
                    .OrderBy(group => group.Key.Name)
                    .Select(level => new
                    {
                        id = $"space-level:{level.Key.Id}",
                        name = level.Key.Name,
                        type = "space-level",
                        children = level.OrderBy(space => space.Number).ThenBy(space => space.Name).Select(space => new
                        {
                            id = $"space:{space.SpaceId}",
                            spaceId = space.SpaceId,
                            name = string.IsNullOrWhiteSpace(space.Number) ? space.Name : $"{space.Number} {space.Name}",
                            type = space.Kind
                        }).ToArray()
                    }).ToArray()
            }
        };
        var properties = new NativeBimModelMetadata
        {
            Model = model,
            Elements = elements.ToDictionary(element => element.Id, element => element.Metadata),
            Types = elements
                .Where(element => element.Metadata.TypeId is not null)
                .GroupBy(element => element.Metadata.TypeId!)
                .ToDictionary(group => group.Key, group => TypeMetadata(group.First().Metadata)),
            Materials = elements
                .SelectMany(element => element.Metadata.Materials)
                .GroupBy(material => material.MaterialId)
                .ToDictionary(group => group.Key, group => group.First()),
            Spaces = spaces
        };
        WriteCompressedJson(Path.Combine(outputDirectory, "hierarchy.json"), hierarchy);
        WriteCompressedJson(Path.Combine(outputDirectory, "properties.json"), properties);
    }

    private static Float3 ToGltf(XYZ point) => new(
        (float)(point.X * FeetToMetres),
        (float)(point.Z * FeetToMetres),
        (float)(-point.Y * FeetToMetres));

    private static NativeBimTypeMetadata TypeMetadata(NativeBimElementMetadata element)
    {
        var display = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var parameter in element.TypeParameters)
        {
            var baseKey = $"类型.{parameter.Name}";
            var key = baseKey;
            var duplicate = 2;
            while (display.ContainsKey(key)) key = $"{baseKey} ({duplicate++})";
            display[key] = parameter.Value;
        }
        return new NativeBimTypeMetadata
        {
            TypeId = element.TypeId!,
            Name = element.Type ?? "",
            Family = element.Family,
            Parameters = element.TypeParameters,
            DisplayProperties = display
        };
    }

    private static void WriteCompressedJson<T>(string path, T value)
    {
        var compactJson = new System.Text.Json.JsonSerializerOptions(JsonFiles.Options) { WriteIndented = false };
        File.WriteAllText(path, System.Text.Json.JsonSerializer.Serialize(value, compactJson));
        using var input = File.OpenRead(path);
        using var output = File.Create(path + ".gz");
        using var gzip = new System.IO.Compression.GZipStream(output, System.IO.Compression.CompressionLevel.Optimal);
        input.CopyTo(gzip);
    }
}

internal sealed class ExportElement
{
    public string Id { get; init; } = "";
    public string UniqueId { get; init; } = "";
    public string Name { get; init; } = "";
    public string Category { get; init; } = "未分类";
    public NativeBimElementMetadata Metadata { get; init; } = null!;
    public Dictionary<string, string> Properties => Metadata.DisplayProperties;
    public List<ExportMesh> Meshes { get; } = new();
    private readonly Dictionary<MaterialStyle, ExportMesh> _meshesByMaterial = new();

    public ExportMesh MeshFor(MaterialStyle material)
    {
        if (_meshesByMaterial.TryGetValue(material, out var existing)) return existing;
        var mesh = new ExportMesh(material);
        _meshesByMaterial.Add(material, mesh);
        Meshes.Add(mesh);
        return mesh;
    }

    public static ExportElement FromRevit(
        Element element,
        Dictionary<string, List<NativeBimParameterMetadata>> typeParameterCache,
        Dictionary<string, NativeBimMaterialMetadata> materialCache)
    {
        var id = ElementIdText(element.Id);
        var category = element.Category?.Name ?? "未分类";
        return new ExportElement
        {
            Id = id,
            UniqueId = element.UniqueId,
            Name = element.Name,
            Category = category,
            Metadata = NativeBimMetadataExtractor.Extract(element.Document, element, typeParameterCache, materialCache)
        };
    }

    private static string ElementIdText(ElementId id)
    {
#if REVITLEGACY
        return id.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
#else
        return id.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
#endif
    }
}

internal sealed class ExportMesh
{
    public ExportMesh(MaterialStyle material) => Material = material;
    public MaterialStyle Material { get; }
    public List<Float3> Positions { get; } = new();
    public List<Float3> Normals { get; } = new();
    public List<uint> Indices { get; } = new();
    private readonly Dictionary<ExportVertex, uint> _vertices = new();

    public void AddTriangle(Float3 p0, Float3 p1, Float3 p2, Float3 normal)
    {
        Indices.Add(VertexIndex(p0, normal));
        Indices.Add(VertexIndex(p1, normal));
        Indices.Add(VertexIndex(p2, normal));
    }

    private uint VertexIndex(Float3 position, Float3 normal)
    {
        var vertex = new ExportVertex(position, normal);
        if (_vertices.TryGetValue(vertex, out var existing)) return existing;
        var index = checked((uint)Positions.Count);
        Positions.Add(position);
        Normals.Add(normal);
        _vertices.Add(vertex, index);
        return index;
    }
}

internal readonly record struct ExportVertex(Float3 Position, Float3 Normal);

internal readonly record struct MaterialStyle(float Red, float Green, float Blue, float Alpha)
{
    public static readonly MaterialStyle Default = new(0.72f, 0.74f, 0.76f, 1f);
}

internal readonly record struct Float3(float X, float Y, float Z)
{
    public static Float3 operator -(Float3 left, Float3 right) => new(left.X - right.X, left.Y - right.Y, left.Z - right.Z);
    public static Float3 Cross(Float3 left, Float3 right) => new(
        left.Y * right.Z - left.Z * right.Y,
        left.Z * right.X - left.X * right.Z,
        left.X * right.Y - left.Y * right.X);
    public static Float3 Normalize(Float3 value)
    {
        var length = (float)Math.Sqrt(value.X * value.X + value.Y * value.Y + value.Z * value.Z);
        return length < 0.000001f ? new Float3(0, 1, 0) : new Float3(value.X / length, value.Y / length, value.Z / length);
    }
}
