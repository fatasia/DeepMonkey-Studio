using Autodesk.Revit.DB;
using System.Globalization;
using System.Text.Json.Serialization;

namespace BimStudio.RevitAddin;

internal sealed class NativeBimModelMetadata
{
    public int SchemaVersion { get; init; } = 2;
    public NativeBimDocumentMetadata Model { get; init; } = null!;
    public Dictionary<string, NativeBimElementMetadata> Elements { get; init; } = new();
    public Dictionary<string, NativeBimTypeMetadata> Types { get; init; } = new();
    public Dictionary<string, NativeBimMaterialMetadata> Materials { get; init; } = new();
    public Dictionary<string, NativeBimSpaceMetadata> Spaces { get; init; } = new();
}

internal sealed class NativeBimDocumentMetadata
{
    public string Name { get; init; } = "";
    public string RevitVersion { get; init; } = "";
    public int ElementCount { get; init; }
    public int LevelCount { get; init; }
    public int SpaceCount { get; init; }
    public Dictionary<string, string> ProjectInformation { get; init; } = new();
}

internal sealed class NativeBimSpaceMetadata
{
    public string SpaceId { get; init; } = "";
    public string UniqueId { get; init; } = "";
    public string Name { get; init; } = "";
    public string? Number { get; init; }
    public string Kind { get; init; } = "Room";
    public string? Level { get; init; }
    public string? LevelId { get; init; }
    public string? Department { get; init; }
    public double? AreaSquareMetres { get; init; }
    public double? VolumeCubicMetres { get; init; }
    public NativeBimBoundsMetadata? Bounds { get; init; }
    public List<NativeBimParameterMetadata> Parameters { get; init; } = new();
}

internal sealed class NativeBimBoundsMetadata
{
    public NativeBimPointMetadata Min { get; init; } = new();
    public NativeBimPointMetadata Max { get; init; } = new();
}

internal sealed class NativeBimPointMetadata
{
    public double X { get; init; }
    public double Y { get; init; }
    public double Z { get; init; }
}

internal sealed class NativeBimElementMetadata
{
    public string ElementId { get; init; } = "";
    public string UniqueId { get; init; } = "";
    public string Name { get; init; } = "";
    public string Category { get; init; } = "";
    public string? CategoryId { get; init; }
    public string? Family { get; init; }
    public string? Type { get; init; }
    public string? TypeId { get; init; }
    public string? Level { get; init; }
    public string? LevelId { get; init; }
    public string? Workset { get; init; }
    public string? WorksetId { get; init; }
    public string? CreatedPhase { get; init; }
    public string? CreatedPhaseId { get; init; }
    public string? DemolishedPhase { get; init; }
    public string? DemolishedPhaseId { get; init; }
    public string? HostId { get; init; }
    public string? GroupId { get; init; }
    public string? AssemblyId { get; init; }
    public string? DesignOptionId { get; init; }
    public List<string> MaterialIds { get; init; } = new();
    [JsonIgnore]
    public List<NativeBimMaterialMetadata> Materials { get; init; } = new();
    public List<NativeBimParameterMetadata> InstanceParameters { get; init; } = new();
    [JsonIgnore]
    public List<NativeBimParameterMetadata> TypeParameters { get; init; } = new();
    [JsonIgnore]
    public Dictionary<string, string> DisplayProperties { get; init; } = new();
}

internal sealed class NativeBimTypeMetadata
{
    public string TypeId { get; init; } = "";
    public string Name { get; init; } = "";
    public string? Family { get; init; }
    public List<NativeBimParameterMetadata> Parameters { get; init; } = new();
    [JsonIgnore]
    public Dictionary<string, string> DisplayProperties { get; init; } = new();
}

internal sealed class NativeBimParameterMetadata
{
    public string Name { get; init; } = "";
    public string Value { get; init; } = "";
    public string? RawValue { get; init; }
    public string StorageType { get; init; } = "";
    public string ParameterId { get; init; } = "";
    public string? DataTypeId { get; init; }
    public string? GroupTypeId { get; init; }
    public bool IsReadOnly { get; init; }
    public bool IsShared { get; init; }
    public string? SharedGuid { get; init; }
}

internal sealed class NativeBimMaterialMetadata
{
    public string MaterialId { get; init; } = "";
    public string Name { get; init; } = "";
    public string Color { get; init; } = "";
    public int Transparency { get; init; }
    public string? MaterialClass { get; init; }
    public string? MaterialCategory { get; init; }
}

internal static class NativeBimMetadataExtractor
{
    private const double FeetToMetres = 0.3048;
    private const double SquareFeetToSquareMetres = 0.09290304;
    private const double CubicFeetToCubicMetres = 0.028316846592;
    public static NativeBimElementMetadata Extract(
        Document document,
        Element element,
        Dictionary<string, List<NativeBimParameterMetadata>> typeParameterCache,
        Dictionary<string, NativeBimMaterialMetadata> materialCache)
    {
        var typeElement = ValidElement(document, element.GetTypeId());
        var typeId = OptionalElementIdText(element.GetTypeId());
        var instanceParameters = ExtractParameters(element);
        var typeParameters = TypeParameters(typeElement, typeId, typeParameterCache);
        var level = ResolveLevel(document, element);
        var workset = ResolveWorkset(document, element);
        var createdPhase = ResolveNamedElement(document, element.CreatedPhaseId);
        var demolishedPhase = ResolveNamedElement(document, element.DemolishedPhaseId);
        var family = element is FamilyInstance familyInstance
            ? familyInstance.Symbol?.FamilyName
            : typeElement?.get_Parameter(BuiltInParameter.SYMBOL_FAMILY_NAME_PARAM)?.AsString();
        var typeName = typeElement?.Name;
        var hostId = element is FamilyInstance hosted && hosted.Host is not null ? ElementIdText(hosted.Host.Id) : null;
        var materials = ExtractMaterials(document, element, materialCache);
        var display = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        Add(display, "ElementId", ElementIdText(element.Id));
        Add(display, "UniqueId", element.UniqueId);
        Add(display, "Name", element.Name);
        Add(display, "Category", element.Category?.Name ?? "未分类");
        Add(display, "CategoryId", OptionalElementIdText(element.Category?.Id));
        Add(display, "Family", family);
        Add(display, "Type", typeName);
        Add(display, "TypeId", typeId);
        Add(display, "Level", level.Name);
        Add(display, "LevelId", level.Id);
        Add(display, "Workset", workset.Name);
        Add(display, "WorksetId", workset.Id);
        Add(display, "CreatedPhase", createdPhase.Name);
        Add(display, "CreatedPhaseId", createdPhase.Id);
        Add(display, "DemolishedPhase", demolishedPhase.Name);
        Add(display, "DemolishedPhaseId", demolishedPhase.Id);
        Add(display, "HostId", hostId);
        Add(display, "GroupId", OptionalElementIdText(element.GroupId));
        Add(display, "AssemblyId", OptionalElementIdText(element.AssemblyInstanceId));
        Add(display, "DesignOptionId", element.DesignOption is null ? null : ElementIdText(element.DesignOption.Id));
        if (materials.Count > 0) Add(display, "Materials", string.Join(", ", materials.Select(material => material.Name).Distinct()));
        AddParameters(display, "实例", instanceParameters);

        return new NativeBimElementMetadata
        {
            ElementId = ElementIdText(element.Id),
            UniqueId = element.UniqueId,
            Name = element.Name,
            Category = element.Category?.Name ?? "未分类",
            CategoryId = OptionalElementIdText(element.Category?.Id),
            Family = family,
            Type = typeName,
            TypeId = typeId,
            Level = level.Name,
            LevelId = level.Id,
            Workset = workset.Name,
            WorksetId = workset.Id,
            CreatedPhase = createdPhase.Name,
            CreatedPhaseId = createdPhase.Id,
            DemolishedPhase = demolishedPhase.Name,
            DemolishedPhaseId = demolishedPhase.Id,
            HostId = hostId,
            GroupId = OptionalElementIdText(element.GroupId),
            AssemblyId = OptionalElementIdText(element.AssemblyInstanceId),
            DesignOptionId = element.DesignOption is null ? null : ElementIdText(element.DesignOption.Id),
            MaterialIds = materials.Select(material => material.MaterialId).Distinct().ToList(),
            Materials = materials,
            InstanceParameters = instanceParameters,
            TypeParameters = typeParameters,
            DisplayProperties = display
        };
    }

    private static List<NativeBimParameterMetadata> TypeParameters(
        Element? typeElement,
        string? typeId,
        Dictionary<string, List<NativeBimParameterMetadata>> cache)
    {
        if (typeElement is null || typeId is null) return new List<NativeBimParameterMetadata>();
        if (cache.TryGetValue(typeId, out var cached)) return cached;
        var parameters = ExtractParameters(typeElement);
        cache[typeId] = parameters;
        return parameters;
    }

    public static NativeBimDocumentMetadata DocumentMetadata(Document document, IReadOnlyCollection<ExportElement> elements, int? spaceCount = null)
    {
        var projectInformation = document.ProjectInformation is null
            ? new Dictionary<string, string>()
            : ExtractParameters(document.ProjectInformation)
                .GroupBy(parameter => parameter.Name, StringComparer.OrdinalIgnoreCase)
                .ToDictionary(group => group.Key, group => group.First().Value, StringComparer.OrdinalIgnoreCase);
        return new NativeBimDocumentMetadata
        {
            Name = Path.GetFileNameWithoutExtension(document.PathName),
            RevitVersion = document.Application.VersionNumber,
            ElementCount = elements.Count,
            LevelCount = elements.Select(element => element.Metadata.LevelId).Where(id => id is not null).Distinct().Count(),
            SpaceCount = spaceCount ?? Spaces(document).Count,
            ProjectInformation = projectInformation
        };
    }

    public static Dictionary<string, NativeBimSpaceMetadata> Spaces(Document document)
    {
        var roomCategory = ElementIdText(new ElementId(BuiltInCategory.OST_Rooms));
        var mepSpaceCategory = ElementIdText(new ElementId(BuiltInCategory.OST_MEPSpaces));
        var spaces = new Dictionary<string, NativeBimSpaceMetadata>();
        foreach (var element in new FilteredElementCollector(document).WhereElementIsNotElementType())
        {
            var categoryId = OptionalElementIdText(element.Category?.Id);
            if (categoryId != roomCategory && categoryId != mepSpaceCategory) continue;
            var id = ElementIdText(element.Id);
            var level = ResolveLevel(document, element);
            var area = element.get_Parameter(BuiltInParameter.ROOM_AREA)?.AsDouble();
            var volume = element.get_Parameter(BuiltInParameter.ROOM_VOLUME)?.AsDouble();
            spaces[id] = new NativeBimSpaceMetadata
            {
                SpaceId = id,
                UniqueId = element.UniqueId,
                Name = element.Name,
                Number = element.get_Parameter(BuiltInParameter.ROOM_NUMBER)?.AsString(),
                Kind = categoryId == roomCategory ? "Room" : "MEP Space",
                Level = level.Name,
                LevelId = level.Id,
                Department = element.get_Parameter(BuiltInParameter.ROOM_DEPARTMENT)?.AsString(),
                AreaSquareMetres = area is > 0 ? area * SquareFeetToSquareMetres : null,
                VolumeCubicMetres = volume is > 0 ? volume * CubicFeetToCubicMetres : null,
                Bounds = SpaceBounds(element),
                Parameters = ExtractParameters(element)
            };
        }
        return spaces;
    }

    private static NativeBimBoundsMetadata? SpaceBounds(Element element)
    {
        var bounds = element.get_BoundingBox(null);
        if (bounds is null) return null;
        var corners = new[]
        {
            new XYZ(bounds.Min.X, bounds.Min.Y, bounds.Min.Z),
            new XYZ(bounds.Min.X, bounds.Min.Y, bounds.Max.Z),
            new XYZ(bounds.Min.X, bounds.Max.Y, bounds.Min.Z),
            new XYZ(bounds.Min.X, bounds.Max.Y, bounds.Max.Z),
            new XYZ(bounds.Max.X, bounds.Min.Y, bounds.Min.Z),
            new XYZ(bounds.Max.X, bounds.Min.Y, bounds.Max.Z),
            new XYZ(bounds.Max.X, bounds.Max.Y, bounds.Min.Z),
            new XYZ(bounds.Max.X, bounds.Max.Y, bounds.Max.Z)
        }.Select(point => ToGltf(bounds.Transform.OfPoint(point))).ToArray();
        return new NativeBimBoundsMetadata
        {
            Min = new NativeBimPointMetadata { X = corners.Min(point => point.X), Y = corners.Min(point => point.Y), Z = corners.Min(point => point.Z) },
            Max = new NativeBimPointMetadata { X = corners.Max(point => point.X), Y = corners.Max(point => point.Y), Z = corners.Max(point => point.Z) }
        };
    }

    private static NativeBimPointMetadata ToGltf(XYZ point) => new()
    {
        X = point.X * FeetToMetres,
        Y = point.Z * FeetToMetres,
        Z = -point.Y * FeetToMetres
    };

    private static List<NativeBimParameterMetadata> ExtractParameters(Element element)
    {
        var parameters = new List<NativeBimParameterMetadata>();
        foreach (Parameter parameter in element.Parameters)
        {
            if (!parameter.HasValue || parameter.Definition is null) continue;
            var raw = RawValue(parameter);
            var value = parameter.AsValueString();
            if (string.IsNullOrWhiteSpace(value)) value = raw;
            if (string.IsNullOrWhiteSpace(value)) continue;
            string? sharedGuid = null;
            if (parameter.IsShared)
            {
                try { sharedGuid = parameter.GUID.ToString("D"); } catch { sharedGuid = null; }
            }
            parameters.Add(new NativeBimParameterMetadata
            {
                Name = parameter.Definition.Name,
                Value = value!,
                RawValue = raw,
                StorageType = parameter.StorageType.ToString(),
                ParameterId = ElementIdText(parameter.Id),
                DataTypeId = TypeId(parameter.Definition.GetDataType()),
                GroupTypeId = TypeId(parameter.Definition.GetGroupTypeId()),
                IsReadOnly = parameter.IsReadOnly,
                IsShared = parameter.IsShared,
                SharedGuid = sharedGuid
            });
        }
        return parameters
            .OrderBy(parameter => parameter.Name, StringComparer.CurrentCultureIgnoreCase)
            .ThenBy(parameter => parameter.ParameterId, StringComparer.Ordinal)
            .ToList();
    }

    private static List<NativeBimMaterialMetadata> ExtractMaterials(
        Document document,
        Element element,
        Dictionary<string, NativeBimMaterialMetadata> cache)
    {
        var ids = element.GetMaterialIds(false).Concat(element.GetMaterialIds(true)).Distinct();
        var result = new List<NativeBimMaterialMetadata>();
        foreach (var id in ids)
        {
            var materialId = ElementIdText(id);
            if (cache.TryGetValue(materialId, out var cached))
            {
                result.Add(cached);
                continue;
            }
            if (document.GetElement(id) is not Material material) continue;
            var metadata = new NativeBimMaterialMetadata
            {
                MaterialId = materialId,
                Name = material.Name,
                Color = $"#{material.Color.Red:X2}{material.Color.Green:X2}{material.Color.Blue:X2}",
                Transparency = material.Transparency,
                MaterialClass = material.MaterialClass,
                MaterialCategory = material.MaterialCategory
            };
            cache[materialId] = metadata;
            result.Add(metadata);
        }
        return result.OrderBy(material => material.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
    }

    private static (string? Id, string? Name) ResolveLevel(Document document, Element element)
    {
        var id = element.LevelId;
        if (!IsValid(id))
        {
            foreach (var builtIn in new[]
                     {
                         BuiltInParameter.FAMILY_LEVEL_PARAM,
                         BuiltInParameter.INSTANCE_REFERENCE_LEVEL_PARAM,
                         BuiltInParameter.SCHEDULE_LEVEL_PARAM
                     })
            {
                var candidate = element.get_Parameter(builtIn)?.AsElementId();
                if (!IsValid(candidate)) continue;
                id = candidate!;
                break;
            }
        }
        return ResolveNamedElement(document, id);
    }

    private static (string? Id, string? Name) ResolveWorkset(Document document, Element element)
    {
        try
        {
            var workset = document.GetWorksetTable().GetWorkset(element.WorksetId);
            return workset is null
                ? (null, null)
                : (workset.Id.IntegerValue.ToString(CultureInfo.InvariantCulture), workset.Name);
        }
        catch
        {
            return (null, null);
        }
    }

    private static (string? Id, string? Name) ResolveNamedElement(Document document, ElementId? id)
    {
        if (!IsValid(id)) return (null, null);
        var referenced = document.GetElement(id!);
        return referenced is null ? (ElementIdText(id!), null) : (ElementIdText(id!), referenced.Name);
    }

    private static Element? ValidElement(Document document, ElementId? id) => IsValid(id) ? document.GetElement(id!) : null;

    private static bool IsValid(ElementId? id) => id is not null && id != ElementId.InvalidElementId;

    private static string? OptionalElementIdText(ElementId? id) => IsValid(id) ? ElementIdText(id!) : null;

    private static string ElementIdText(ElementId id)
    {
#if REVIT2023
        return id.IntegerValue.ToString(CultureInfo.InvariantCulture);
#else
        return id.Value.ToString(CultureInfo.InvariantCulture);
#endif
    }

    private static string? RawValue(Parameter parameter) => parameter.StorageType switch
    {
        StorageType.String => parameter.AsString(),
        StorageType.Integer => parameter.AsInteger().ToString(CultureInfo.InvariantCulture),
        StorageType.Double => parameter.AsDouble().ToString("G17", CultureInfo.InvariantCulture),
        StorageType.ElementId => OptionalElementIdText(parameter.AsElementId()),
        _ => null
    };

    private static string? TypeId(ForgeTypeId? id) => id is null || id.Empty() ? null : id.TypeId;

    private static void Add(Dictionary<string, string> properties, string key, string? value)
    {
        if (!string.IsNullOrWhiteSpace(value)) properties[key] = value!;
    }

    private static void AddParameters(
        Dictionary<string, string> properties,
        string prefix,
        IEnumerable<NativeBimParameterMetadata> parameters)
    {
        foreach (var parameter in parameters)
        {
            var baseKey = $"{prefix}.{parameter.Name}";
            var key = baseKey;
            var duplicate = 2;
            while (properties.ContainsKey(key)) key = $"{baseKey} ({duplicate++})";
            properties[key] = parameter.Value;
        }
    }
}
