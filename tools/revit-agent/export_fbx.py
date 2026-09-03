"""Revit Batch Processor task: export the first available 3D view to model.fbx."""
import clr
import os

clr.AddReference("RevitAPI")
from Autodesk.Revit.DB import FBXExportOptions, FilteredElementCollector, Transaction, View3D, ViewSet

import revit_script_util
from revit_script_util import Output

doc = revit_script_util.GetScriptDocument()
output_dir = os.environ.get("BIM_STUDIO_OUTPUT_DIR")

if not output_dir:
    raise Exception("BIM_STUDIO_OUTPUT_DIR is not configured")

if not os.path.isdir(output_dir):
    os.makedirs(output_dir)

view = doc.ActiveView if isinstance(doc.ActiveView, View3D) and not doc.ActiveView.IsTemplate else None
if view is None:
    view = next(
        (candidate for candidate in FilteredElementCollector(doc).OfClass(View3D) if not candidate.IsTemplate),
        None,
    )

if view is None:
    raise Exception("No exportable 3D view was found")

views = ViewSet()
views.Insert(view)
options = FBXExportOptions()

transaction = Transaction(doc, "Industrial Studio FBX Export")
transaction.Start()
try:
    success = doc.Export(output_dir, "model", views, options)
    if not success:
        raise Exception("Revit Document.Export returned false")
finally:
    transaction.RollBack()

Output("Industrial Studio exported FBX to: " + os.path.join(output_dir, "model.fbx"))
