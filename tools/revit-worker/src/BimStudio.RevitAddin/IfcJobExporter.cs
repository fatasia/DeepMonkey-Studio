using Autodesk.Revit.DB;

namespace BimStudio.RevitAddin;

internal static class IfcJobExporter
{
    public static void Export(Document document, string outputDirectory)
    {
        var options = new IFCExportOptions { FileVersion = IFCVersion.IFC4 };
        options.AddOption("ExportRevitPropertySets", "true");
        options.AddOption("ExportIFCCommonPropertySets", "true");
        options.AddOption("ExportBaseQuantities", "true");
        options.AddOption("ExportInternalRevitPropertySets", "true");
        options.AddOption("StoreIFCGUID", "true");
        options.AddOption("UseActiveViewGeometry", "false");
        using var transaction = new Transaction(document, "Industrial Studio IFC Export");
        transaction.Start();
        try
        {
            if (!document.Export(outputDirectory, "model.ifc", options))
                throw new InvalidOperationException("Revit Document.Export 返回 false");
        }
        finally
        {
            transaction.RollBack();
        }
    }
}
