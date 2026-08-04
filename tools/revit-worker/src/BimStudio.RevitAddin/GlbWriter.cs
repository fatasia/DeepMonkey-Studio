using System.Text;
using System.Text.Json;

namespace BimStudio.RevitAddin;

internal static class GlbWriter
{
    public static void Write(string path, string modelName, IReadOnlyList<ExportElement> elements)
    {
        using var binaryStream = new MemoryStream();
        using var binary = new BinaryWriter(binaryStream, Encoding.UTF8, true);
        var bufferViews = new List<Dictionary<string, object>>();
        var accessors = new List<Dictionary<string, object>>();
        var materials = new List<Dictionary<string, object>>();
        var materialIndices = new Dictionary<MaterialStyle, int>();
        var meshes = new List<Dictionary<string, object>>();
        var nodes = new List<Dictionary<string, object>>();

        var rootChildren = new List<int>();
        nodes.Add(new Dictionary<string, object> { ["name"] = modelName, ["children"] = rootChildren });
        foreach (var categoryGroup in elements.GroupBy(element => element.Category).OrderBy(group => group.Key))
        {
            var categoryChildren = new List<int>();
            var categoryNode = nodes.Count;
            nodes.Add(new Dictionary<string, object>
            {
                ["name"] = categoryGroup.Key,
                ["children"] = categoryChildren,
                ["extras"] = new Dictionary<string, object> { ["Category"] = categoryGroup.Key, ["NodeType"] = "Category" }
            });
            rootChildren.Add(categoryNode);

            foreach (var element in categoryGroup)
            {
                var elementChildren = new List<int>();
                var elementNode = nodes.Count;
                nodes.Add(new Dictionary<string, object>
                {
                    ["name"] = string.IsNullOrWhiteSpace(element.Name) ? $"构件 {element.Id}" : element.Name,
                    ["children"] = elementChildren,
                    ["extras"] = new Dictionary<string, object>
                    {
                        ["NodeType"] = "Element",
                        ["ElementId"] = element.Id,
                        ["UniqueId"] = element.UniqueId,
                        ["Category"] = element.Category,
                        ["Name"] = element.Name,
                        ["Level"] = element.Metadata.Level ?? "",
                        ["Family"] = element.Metadata.Family ?? "",
                        ["Type"] = element.Metadata.Type ?? ""
                    }
                });
                categoryChildren.Add(elementNode);

                foreach (var exportMesh in element.Meshes)
                {
                    var positionAccessor = WriteVectorAccessor(binary, exportMesh.Positions, bufferViews, accessors, true);
                    var normalAccessor = WriteNormalAccessor(binary, exportMesh.Normals, bufferViews, accessors);
                    var indexAccessor = WriteIndexAccessor(binary, exportMesh.Indices, bufferViews, accessors);
                    if (!materialIndices.TryGetValue(exportMesh.Material, out var materialIndex))
                    {
                        materialIndex = materials.Count;
                        materialIndices[exportMesh.Material] = materialIndex;
                        materials.Add(MaterialJson(exportMesh.Material));
                    }
                    var meshIndex = meshes.Count;
                    meshes.Add(new Dictionary<string, object>
                    {
                        ["name"] = $"{element.Name} 几何 {meshIndex + 1}",
                        ["primitives"] = new object[]
                        {
                            new Dictionary<string, object>
                            {
                                ["attributes"] = new Dictionary<string, object> { ["POSITION"] = positionAccessor, ["NORMAL"] = normalAccessor },
                                ["indices"] = indexAccessor,
                                ["material"] = materialIndex,
                                ["mode"] = 4
                            }
                        }
                    });
                    var meshNode = nodes.Count;
                    nodes.Add(new Dictionary<string, object>
                    {
                        ["name"] = $"Mesh {element.Id}",
                        ["mesh"] = meshIndex,
                        ["extras"] = new Dictionary<string, object> { ["ElementId"] = element.Id, ["UniqueId"] = element.UniqueId }
                    });
                    elementChildren.Add(meshNode);
                }
            }
        }

        var root = new Dictionary<string, object>
        {
            ["asset"] = new Dictionary<string, object> { ["version"] = "2.0", ["generator"] = "BIM Studio Revit Add-in" },
            ["scene"] = 0,
            ["scenes"] = new object[] { new Dictionary<string, object> { ["name"] = modelName, ["nodes"] = new[] { 0 } } },
            ["nodes"] = nodes,
            ["meshes"] = meshes,
            ["materials"] = materials,
            ["accessors"] = accessors,
            ["bufferViews"] = bufferViews,
            ["buffers"] = new object[] { new Dictionary<string, object> { ["byteLength"] = checked((int)binaryStream.Length) } }
        };
        var json = JsonSerializer.SerializeToUtf8Bytes(root, new JsonSerializerOptions(JsonFiles.Options) { WriteIndented = false });
        WriteGlb(path, json, binaryStream.ToArray());
    }

    private static int WriteVectorAccessor(
        BinaryWriter binary,
        IReadOnlyList<Float3> values,
        List<Dictionary<string, object>> bufferViews,
        List<Dictionary<string, object>> accessors,
        bool includeBounds)
    {
        Align4(binary);
        var offset = checked((int)binary.BaseStream.Position);
        var min = new[] { float.PositiveInfinity, float.PositiveInfinity, float.PositiveInfinity };
        var max = new[] { float.NegativeInfinity, float.NegativeInfinity, float.NegativeInfinity };
        foreach (var value in values)
        {
            binary.Write(value.X);
            binary.Write(value.Y);
            binary.Write(value.Z);
            min[0] = Math.Min(min[0], value.X); min[1] = Math.Min(min[1], value.Y); min[2] = Math.Min(min[2], value.Z);
            max[0] = Math.Max(max[0], value.X); max[1] = Math.Max(max[1], value.Y); max[2] = Math.Max(max[2], value.Z);
        }
        var viewIndex = bufferViews.Count;
        bufferViews.Add(new Dictionary<string, object>
        {
            ["buffer"] = 0,
            ["byteOffset"] = offset,
            ["byteLength"] = values.Count * 12,
            ["target"] = 34962
        });
        var accessor = new Dictionary<string, object>
        {
            ["bufferView"] = viewIndex,
            ["componentType"] = 5126,
            ["count"] = values.Count,
            ["type"] = "VEC3"
        };
        if (includeBounds && values.Count > 0)
        {
            accessor["min"] = min;
            accessor["max"] = max;
        }
        var accessorIndex = accessors.Count;
        accessors.Add(accessor);
        return accessorIndex;
    }

    private static int WriteIndexAccessor(
        BinaryWriter binary,
        IReadOnlyList<uint> values,
        List<Dictionary<string, object>> bufferViews,
        List<Dictionary<string, object>> accessors)
    {
        Align4(binary);
        var offset = checked((int)binary.BaseStream.Position);
        var max = values.Count == 0 ? 0u : values.Max();
        var componentType = max <= ushort.MaxValue ? 5123 : 5125;
        foreach (var value in values)
        {
            if (componentType == 5123) binary.Write(checked((ushort)value));
            else binary.Write(value);
        }
        var componentSize = componentType == 5123 ? 2 : 4;
        var viewIndex = bufferViews.Count;
        bufferViews.Add(new Dictionary<string, object>
        {
            ["buffer"] = 0,
            ["byteOffset"] = offset,
            ["byteLength"] = values.Count * componentSize,
            ["target"] = 34963
        });
        var accessorIndex = accessors.Count;
        accessors.Add(new Dictionary<string, object>
        {
            ["bufferView"] = viewIndex,
            ["componentType"] = componentType,
            ["count"] = values.Count,
            ["type"] = "SCALAR",
            ["min"] = new[] { 0u },
            ["max"] = new[] { max }
        });
        return accessorIndex;
    }

    private static int WriteNormalAccessor(
        BinaryWriter binary,
        IReadOnlyList<Float3> values,
        List<Dictionary<string, object>> bufferViews,
        List<Dictionary<string, object>> accessors)
    {
        Align4(binary);
        var offset = checked((int)binary.BaseStream.Position);
        foreach (var value in values)
        {
            binary.Write(NormalComponent(value.X));
            binary.Write(NormalComponent(value.Y));
            binary.Write(NormalComponent(value.Z));
        }
        var viewIndex = bufferViews.Count;
        bufferViews.Add(new Dictionary<string, object>
        {
            ["buffer"] = 0,
            ["byteOffset"] = offset,
            ["byteLength"] = values.Count * 6,
            ["byteStride"] = 6,
            ["target"] = 34962
        });
        var accessorIndex = accessors.Count;
        accessors.Add(new Dictionary<string, object>
        {
            ["bufferView"] = viewIndex,
            ["componentType"] = 5122,
            ["normalized"] = true,
            ["count"] = values.Count,
            ["type"] = "VEC3"
        });
        return accessorIndex;
    }

    private static short NormalComponent(float value) =>
        checked((short)Math.Round(Math.Max(-1f, Math.Min(1f, value)) * short.MaxValue));

    private static Dictionary<string, object> MaterialJson(MaterialStyle material) => new()
    {
        ["name"] = $"Material {material.Red:F3} {material.Green:F3} {material.Blue:F3}",
        ["pbrMetallicRoughness"] = new Dictionary<string, object>
        {
            ["baseColorFactor"] = new[] { material.Red, material.Green, material.Blue, material.Alpha },
            ["metallicFactor"] = 0f,
            ["roughnessFactor"] = 0.82f
        },
        ["doubleSided"] = true,
        ["alphaMode"] = material.Alpha < 0.999f ? "BLEND" : "OPAQUE"
    };

    private static void Align4(BinaryWriter writer)
    {
        while (writer.BaseStream.Position % 4 != 0) writer.Write((byte)0);
    }

    private static void WriteGlb(string path, byte[] json, byte[] binary)
    {
        var jsonPadding = (4 - json.Length % 4) % 4;
        var binaryPadding = (4 - binary.Length % 4) % 4;
        var totalLength = 12 + 8 + json.Length + jsonPadding + 8 + binary.Length + binaryPadding;
        using var stream = File.Create(path);
        using var writer = new BinaryWriter(stream, Encoding.UTF8, false);
        writer.Write(0x46546C67u);
        writer.Write(2u);
        writer.Write((uint)totalLength);
        writer.Write((uint)(json.Length + jsonPadding));
        writer.Write(0x4E4F534Au);
        writer.Write(json);
        for (var index = 0; index < jsonPadding; index++) writer.Write((byte)0x20);
        writer.Write((uint)(binary.Length + binaryPadding));
        writer.Write(0x004E4942u);
        writer.Write(binary);
        for (var index = 0; index < binaryPadding; index++) writer.Write((byte)0);
    }
}
