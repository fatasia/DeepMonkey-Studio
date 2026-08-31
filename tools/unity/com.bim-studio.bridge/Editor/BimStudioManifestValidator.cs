using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace BimStudio.Bridge.Editor
{
    public sealed class BimStudioManifestValidation
    {
        public readonly List<string> errors = new List<string>();
        public readonly List<string> warnings = new List<string>();
        public bool IsValid => errors.Count == 0;
    }

    public static class BimStudioManifestValidator
    {
        private static readonly HashSet<string> PropertyTypes = new HashSet<string>(StringComparer.Ordinal)
        {
            "string", "number", "boolean", "color", "select"
        };

        public static BimStudioManifestValidation Validate(BimStudioManifestAsset manifest)
        {
            var result = new BimStudioManifestValidation();
            if (manifest == null)
            {
                result.errors.Add("缺少 BimStudioManifest 集成清单资源。");
                return result;
            }

            ValidateNames("事件", manifest.events, result);
            ValidateNames("动作", manifest.actions, result);
            ValidateDataLayers(manifest.dataLayers ?? Array.Empty<BimStudioDataLayer>(), result);
            ValidateObjects(manifest.objects ?? Array.Empty<BimStudioObject>(), result);
            ValidateProperties(manifest.properties ?? Array.Empty<BimStudioProperty>(), manifest.objects ?? Array.Empty<BimStudioObject>(), result);
            ValidateSceneBindings(manifest, result);

            var version = Application.unityVersion ?? string.Empty;
            if (!version.StartsWith("2022.3", StringComparison.Ordinal) && !version.StartsWith("6000.0", StringComparison.Ordinal))
                result.warnings.Add($"Unity {version} 不在已验证版本范围内（2022.3 LTS / 6000.0），请先对当前补丁版本进行构建验证。");
            if (manifest.events == null || manifest.events.Length == 0)
                result.warnings.Add("尚未声明 Unity 发出的事件；场景可以渲染，但平台无法生成类型化的交互选项。");
            return result;
        }

        private static void ValidateNames(string label, IEnumerable<string> values, BimStudioManifestValidation result)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var index = 0;
            foreach (var raw in values ?? Array.Empty<string>())
            {
                var value = (raw ?? string.Empty).Trim();
                if (value.Length == 0) result.errors.Add($"{label} #{index + 1} 的名称为空。");
                else if (!seen.Add(value)) result.errors.Add($"{label}名称重复：{value}。");
                index++;
            }
        }

        private static void ValidateDataLayers(IEnumerable<BimStudioDataLayer> layers, BimStudioManifestValidation result)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var index = 0;
            foreach (var layer in layers)
            {
                var key = (layer?.key ?? string.Empty).Trim();
                if (key.Length == 0) result.errors.Add($"数据层 #{index + 1} 的标识为空。");
                else if (!seen.Add(key)) result.errors.Add($"数据层标识重复：{key}。");
                if (layer != null && string.IsNullOrWhiteSpace(layer.target)) result.warnings.Add($"数据层 {key} 没有目标适配器，Unity 项目需要自行路由。");
                index++;
            }
        }

        private static void ValidateObjects(IEnumerable<BimStudioObject> objects, BimStudioManifestValidation result)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var index = 0;
            foreach (var item in objects)
            {
                var id = (item?.id ?? string.Empty).Trim();
                if (id.Length == 0) result.errors.Add($"业务对象 #{index + 1} 的稳定 ID 为空。");
                else if (!seen.Add(id)) result.errors.Add($"业务对象 ID 重复：{id}。");
                if (item != null && string.IsNullOrWhiteSpace(item.path)) result.warnings.Add($"业务对象 {id} 没有场景路径，运行时需要使用自定义注册表查找。");
                index++;
            }
        }

        private static void ValidateProperties(IEnumerable<BimStudioProperty> properties, IEnumerable<BimStudioObject> objects, BimStudioManifestValidation result)
        {
            var objectIds = new HashSet<string>(objects.Select(item => item?.id).Where(id => !string.IsNullOrWhiteSpace(id)), StringComparer.Ordinal);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var index = 0;
            foreach (var property in properties)
            {
                var key = (property?.key ?? string.Empty).Trim();
                if (key.Length == 0) result.errors.Add($"可配置属性 #{index + 1} 的标识为空。");
                else if (!seen.Add(key)) result.errors.Add($"可配置属性标识重复：{key}。");
                if (property != null && !PropertyTypes.Contains(property.type ?? string.Empty)) result.errors.Add($"属性 {key} 使用了不支持的类型：{property.type}。");
                if (property != null && !string.IsNullOrWhiteSpace(property.target) && !objectIds.Contains(property.target)) result.errors.Add($"属性 {key} 指向未声明的业务对象：{property.target}。");
                if (property != null && property.type == "select" && (property.options == null || property.options.Length == 0)) result.errors.Add($"选择型属性 {key} 没有可选项。");
                index++;
            }
        }

        private static void ValidateSceneBindings(BimStudioManifestAsset manifest, BimStudioManifestValidation result)
        {
            var dataLayers = new HashSet<string>((manifest.dataLayers ?? Array.Empty<BimStudioDataLayer>()).Select(item => item?.key?.Trim()).Where(value => !string.IsNullOrWhiteSpace(value)), StringComparer.Ordinal);
            var properties = new HashSet<string>((manifest.properties ?? Array.Empty<BimStudioProperty>()).Select(item => item?.key?.Trim()).Where(value => !string.IsNullOrWhiteSpace(value)), StringComparer.Ordinal);
            var actions = new HashSet<string>((manifest.actions ?? Array.Empty<string>()).Select(value => value?.Trim()).Where(value => !string.IsNullOrWhiteSpace(value)), StringComparer.Ordinal);
            var events = new HashSet<string>((manifest.events ?? Array.Empty<string>()).Select(value => value?.Trim()).Where(value => !string.IsNullOrWhiteSpace(value)), StringComparer.Ordinal);
            var objects = new HashSet<string>((manifest.objects ?? Array.Empty<BimStudioObject>()).Select(item => item?.id?.Trim()).Where(value => !string.IsNullOrWhiteSpace(value)), StringComparer.Ordinal);

            foreach (var binding in SceneComponents<MonoBehaviour>().OfType<IBimStudioValueContractBinding>())
            {
                var key = (binding.ContractKey ?? string.Empty).Trim();
                var declared = binding.ContractSource == BimStudioValueSource.DataLayer ? dataLayers : properties;
                if (key.Length == 0) result.errors.Add($"场景对象 {HierarchyPath(binding.ContractObject.transform)} 的数据 / 属性绑定没有选择标识。");
                else if (!declared.Contains(key)) result.errors.Add($"场景对象 {HierarchyPath(binding.ContractObject.transform)} 引用了未声明的{(binding.ContractSource == BimStudioValueSource.DataLayer ? "数据层" : "属性")}：{key}。");
            }
            foreach (var binding in SceneComponents<BimStudioActionBinding>())
            {
                var action = (binding.action ?? string.Empty).Trim();
                var objectId = (binding.objectId ?? string.Empty).Trim();
                if (action.Length == 0) result.errors.Add($"场景对象 {HierarchyPath(binding.transform)} 的动作绑定没有选择动作。");
                else if (!actions.Contains(action)) result.errors.Add($"场景对象 {HierarchyPath(binding.transform)} 引用了未声明的动作：{action}。");
                if (objectId.Length > 0 && !objects.Contains(objectId)) result.errors.Add($"场景对象 {HierarchyPath(binding.transform)} 引用了未声明的业务对象：{objectId}。");
            }
            foreach (var emitter in SceneComponents<MonoBehaviour>().OfType<IBimStudioEventContractBinding>())
            {
                var eventName = (emitter.ContractEventName ?? string.Empty).Trim();
                if (eventName.Length == 0 && emitter is BimStudioEventEmitter) result.errors.Add($"场景对象 {HierarchyPath(emitter.ContractObject.transform)} 的事件回传没有选择事件。");
                else if (eventName.Length > 0 && !events.Contains(eventName)) result.errors.Add($"场景对象 {HierarchyPath(emitter.ContractObject.transform)} 引用了未声明的回传事件：{eventName}。");
            }
        }

        private static IEnumerable<T> SceneComponents<T>() where T : Component
        {
            return Resources.FindObjectsOfTypeAll<T>().Where(component => component != null && component.gameObject.scene.IsValid() && component.gameObject.scene.isLoaded);
        }

        private static string HierarchyPath(Transform transform)
        {
            var names = new List<string>();
            for (var current = transform; current != null; current = current.parent) names.Add(current.name);
            names.Reverse();
            return transform.gameObject.scene.name + "/" + string.Join("/", names);
        }
    }
}
