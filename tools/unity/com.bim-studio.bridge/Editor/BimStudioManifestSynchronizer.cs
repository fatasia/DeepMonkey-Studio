using System;
using System.Collections.Generic;
using System.Linq;
using BimStudio.Bridge;
using UnityEditor;
using UnityEngine;

namespace BimStudio.Bridge.Editor
{
    public sealed class BimStudioManifestSyncResult
    {
        public int dataLayers;
        public int properties;
        public int actions;
        public int events;
        public int objects;
        public int updatedPaths;
        public int Total => dataLayers + properties + actions + events + objects + updatedPaths;
    }

    /// <summary>
    /// Discovers no-code bindings in all loaded scenes and merges their stable
    /// contract into the manifest. Core and optional uGUI bindings share the
    /// same small contract interfaces; existing labels, types and options are kept.
    /// </summary>
    public static class BimStudioManifestSynchronizer
    {
        [MenuItem("Deep Monkey Studio/从场景自动同步集成清单", priority = 3)]
        public static void SynchronizeMenu()
        {
            var manifest = BimStudioProjectSetup.EnsureManifest();
            var result = Synchronize(manifest);
            Selection.activeObject = manifest;
            EditorGUIUtility.PingObject(manifest);
            EditorUtility.DisplayDialog("Deep Monkey Studio", result.Total == 0
                ? "场景绑定与集成清单已经一致。"
                : $"同步完成：数据层 {result.dataLayers}、属性 {result.properties}、动作 {result.actions}、事件 {result.events}、业务对象 {result.objects}、路径更新 {result.updatedPaths}。", "确定");
        }

        public static BimStudioManifestSyncResult Synchronize(BimStudioManifestAsset manifest)
        {
            if (manifest == null) throw new ArgumentNullException(nameof(manifest));
            var result = new BimStudioManifestSyncResult();
            Undo.RecordObject(manifest, "Synchronize Deep Monkey Studio manifest");

            var layers = (manifest.dataLayers ?? Array.Empty<BimStudioDataLayer>()).Where(item => item != null).ToList();
            var properties = (manifest.properties ?? Array.Empty<BimStudioProperty>()).Where(item => item != null).ToList();
            var actions = new HashSet<string>((manifest.actions ?? Array.Empty<string>()).Select(Clean).Where(HasText), StringComparer.Ordinal);
            var events = new HashSet<string>((manifest.events ?? Array.Empty<string>()).Select(Clean).Where(HasText), StringComparer.Ordinal);
            var objects = (manifest.objects ?? Array.Empty<BimStudioObject>()).Where(item => item != null).ToList();

            foreach (var binding in SceneComponents<MonoBehaviour>().OfType<IBimStudioValueContractBinding>())
            {
                var key = Clean(binding.ContractKey);
                if (!HasText(key)) continue;
                var declaredProperty = binding.ContractSource == BimStudioValueSource.Property ? properties.FirstOrDefault(item => Clean(item.key) == key) : null;
                if (binding.ContractObject == null) continue;
                var objectId = EnsureObject(objects, binding.ContractObject, result, declaredProperty?.target);
                if (binding.ContractSource == BimStudioValueSource.DataLayer)
                {
                    if (layers.Any(item => Clean(item.key) == key)) continue;
                    layers.Add(new BimStudioDataLayer { key = key, description = binding.ContractObject.name, target = binding.GetType().Name });
                    result.dataLayers++;
                }
                else
                {
                    var property = declaredProperty;
                    if (property == null)
                    {
                        properties.Add(new BimStudioProperty { key = key, label = key, type = binding.ContractValueType, target = objectId });
                        result.properties++;
                    }
                    else if (string.IsNullOrWhiteSpace(property.target)) property.target = objectId;
                }
            }
            foreach (var binding in SceneComponents<BimStudioActionBinding>())
            {
                var action = Clean(binding.action);
                if (HasText(action) && actions.Add(action)) result.actions++;
                var objectId = EnsureObject(objects, binding.gameObject, result, binding.objectId);
                if (string.IsNullOrWhiteSpace(binding.objectId))
                {
                    Undo.RecordObject(binding, "Assign Deep Monkey Studio object ID");
                    binding.objectId = objectId;
                    EditorUtility.SetDirty(binding);
                }
            }
            foreach (var emitter in SceneComponents<MonoBehaviour>().OfType<IBimStudioEventContractBinding>())
            {
                if (emitter.ContractObject == null) continue;
                var eventName = Clean(emitter.ContractEventName);
                if (HasText(eventName) && events.Add(eventName)) result.events++;
                EnsureObject(objects, emitter.ContractObject, result);
            }

            manifest.dataLayers = layers.OrderBy(item => item.key, StringComparer.Ordinal).ToArray();
            manifest.properties = properties.OrderBy(item => item.key, StringComparer.Ordinal).ToArray();
            manifest.actions = actions.OrderBy(item => item, StringComparer.Ordinal).ToArray();
            manifest.events = events.OrderBy(item => item, StringComparer.Ordinal).ToArray();
            manifest.objects = objects.OrderBy(item => item.id, StringComparer.Ordinal).ToArray();
            EditorUtility.SetDirty(manifest);
            AssetDatabase.SaveAssets();
            return result;
        }

        private static string EnsureObject(List<BimStudioObject> objects, GameObject gameObject, BimStudioManifestSyncResult result, string preferredId = null)
        {
            var path = ScenePath(gameObject.transform);
            var preferred = HasText(preferredId) ? objects.FirstOrDefault(item => string.Equals(item.id, preferredId.Trim(), StringComparison.Ordinal)) : null;
            if (preferred != null)
            {
                if (!string.Equals(preferred.path, path, StringComparison.Ordinal)) { preferred.path = path; result.updatedPaths++; }
                preferred.name = gameObject.name;
                return preferred.id;
            }
            var existing = objects.FirstOrDefault(item => string.Equals(item.path, path, StringComparison.Ordinal));
            if (existing != null)
            {
                if (existing.name != gameObject.name) existing.name = gameObject.name;
                return existing.id;
            }
            var id = StableId(gameObject.name, objects.Select(item => item.id));
            objects.Add(new BimStudioObject { id = id, name = gameObject.name, path = path, tags = gameObject.CompareTag("Untagged") ? Array.Empty<string>() : new[] { gameObject.tag } });
            result.objects++;
            return id;
        }

        private static string StableId(string name, IEnumerable<string> existing)
        {
            var stem = new string((name ?? "object").Trim().Select(character => char.IsLetterOrDigit(character) || character == '-' || character == '_' ? character : '-').ToArray()).Trim('-');
            if (!HasText(stem)) stem = "object";
            var used = new HashSet<string>(existing.Where(HasText), StringComparer.Ordinal);
            var id = stem;
            for (var suffix = 2; used.Contains(id); suffix++) id = stem + "-" + suffix;
            return id;
        }

        private static IEnumerable<T> SceneComponents<T>() where T : Component
        {
            return Resources.FindObjectsOfTypeAll<T>().Where(component => component != null && component.gameObject.scene.IsValid() && component.gameObject.scene.isLoaded);
        }

        private static string ScenePath(Transform transform)
        {
            var names = new List<string>();
            for (var current = transform; current != null; current = current.parent) names.Add(current.name);
            names.Reverse();
            return transform.gameObject.scene.name + "/" + string.Join("/", names);
        }

        private static string Clean(string value) => (value ?? string.Empty).Trim();
        private static bool HasText(string value) => !string.IsNullOrWhiteSpace(value);
    }
}
