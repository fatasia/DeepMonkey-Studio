using System;
using System.Linq;
using BimStudio.Bridge.Editor;
using BimStudio.Bridge.UGUI;
using UnityEditor;
using UnityEngine;

namespace BimStudio.Bridge.UGUI.Editor
{
    [CustomEditor(typeof(BimStudioUGuiBinding))]
    public sealed class BimStudioUGuiBindingEditor : UnityEditor.Editor
    {
        private string newProperty = string.Empty;
        private string newEvent = string.Empty;

        public override void OnInspectorGUI()
        {
            serializedObject.Update();
            var manifest = BimStudioBindingEditorUtility.LoadManifest();
            BimStudioBindingEditorUtility.DrawManifestLink(manifest);

            var property = serializedObject.FindProperty("propertyKey");
            var properties = manifest?.properties?
                .Select(item => item?.key)
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .ToArray() ?? Array.Empty<string>();
            BimStudioBindingEditorUtility.DrawChoice(property, "平台属性", properties, "请先在集成清单中声明属性。");
            DrawQuickCreate(manifest, property, true);

            var target = serializedObject.FindProperty("target");
            target.enumValueIndex = EditorGUILayout.Popup("uGUI 更新目标", target.enumValueIndex, new[]
            {
                "文本", "滑块值", "开关值", "下拉选项", "输入文本",
                "图片填充", "图片颜色", "画布透明度", "是否可交互"
            });
            DrawTargetField((BimStudioUGuiTarget)target.enumValueIndex);

            EditorGUILayout.Space(4);
            var outputEvent = serializedObject.FindProperty("outputEvent");
            var events = manifest?.events?.Where(value => !string.IsNullOrWhiteSpace(value)).ToArray() ?? Array.Empty<string>();
            BimStudioBindingEditorUtility.DrawChoice(outputEvent, "回传事件（可选）", events, "只接收平台属性时可以留空。", true);
            DrawQuickCreate(manifest, outputEvent, false);
            EditorGUILayout.HelpBox("Slider、Toggle、Dropdown 和 InputField 支持双向回传；平台回写不会再次触发事件。", MessageType.Info);

            if (string.IsNullOrWhiteSpace(property.stringValue))
                EditorGUILayout.HelpBox("构建 WebGL 前请选择平台属性。", MessageType.Error);
            serializedObject.ApplyModifiedProperties();
        }

        private void DrawTargetField(BimStudioUGuiTarget value)
        {
            string field;
            switch (value)
            {
                case BimStudioUGuiTarget.Text: field = "text"; break;
                case BimStudioUGuiTarget.SliderValue: field = "slider"; break;
                case BimStudioUGuiTarget.ToggleValue: field = "toggle"; break;
                case BimStudioUGuiTarget.DropdownValue: field = "dropdown"; break;
                case BimStudioUGuiTarget.InputText: field = "input"; break;
                case BimStudioUGuiTarget.ImageFill:
                case BimStudioUGuiTarget.ImageColor: field = "image"; break;
                case BimStudioUGuiTarget.CanvasAlpha: field = "canvasGroup"; break;
                default: field = "selectable"; break;
            }
            EditorGUILayout.PropertyField(serializedObject.FindProperty(field), new GUIContent("目标组件"));
        }

        private void DrawQuickCreate(BimStudioManifestAsset manifest, SerializedProperty destination, bool isProperty)
        {
            if (manifest == null) return;
            var draft = isProperty ? newProperty : newEvent;
            using (new EditorGUILayout.HorizontalScope())
            {
                draft = EditorGUILayout.TextField(isProperty ? "快速新建属性" : "快速新建事件", draft);
                using (new EditorGUI.DisabledScope(string.IsNullOrWhiteSpace(draft)))
                {
                    if (!GUILayout.Button("新建并选中", GUILayout.Width(86))) return;
                    destination.stringValue = isProperty
                        ? BimStudioBindingEditorUtility.AddProperty(manifest, draft, ((BimStudioUGuiBinding)target).gameObject)
                        : BimStudioBindingEditorUtility.AddEvent(manifest, draft);
                    if (isProperty) newProperty = string.Empty;
                    else newEvent = string.Empty;
                }
            }
        }
    }
}
