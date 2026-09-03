"""Revit Batch Processor task: export the current RVT document to Industrial Studio's model.ifc."""
import clr
import os

clr.AddReference("RevitAPI")
from Autodesk.Revit.DB import IFCExportOptions, IFCVersion, Transaction

import revit_script_util
from revit_script_util import Output

doc = revit_script_util.GetScriptDocument()
output_dir = os.environ.get("BIM_STUDIO_OUTPUT_DIR")

if not output_dir:
    raise Exception("BIM_STUDIO_OUTPUT_DIR is not configured")

if not os.path.isdir(output_dir):
    os.makedirs(output_dir)

options = IFCExportOptions()
options.FileVersion = IFCVersion.IFC4
options.AddOption("ExportRevitPropertySets", "true")
options.AddOption("ExportIFCCommonPropertySets", "true")
options.AddOption("ExportBaseQuantities", "true")
options.AddOption("ExportInternalRevitPropertySets", "true")
options.AddOption("StoreIFCGUID", "true")
options.AddOption("UseActiveViewGeometry", "false")

transaction = Transaction(doc, "Industrial Studio IFC Export")
transaction.Start()
try:
    success = doc.Export(output_dir, "model.ifc", options)
    if not success:
        raise Exception("Revit Document.Export returned false")
finally:
    transaction.RollBack()

Output("Industrial Studio exported IFC to: " + os.path.join(output_dir, "model.ifc"))
