import { useCallback, useEffect, useRef, useState } from "react";
import type { AssetLibraryDimension, AssetLibraryPage } from "@bim-studio/contracts";
import { api } from "../api";

const EMPTY_PAGE: AssetLibraryPage = {
  items: [],
  page: 1,
  pageSize: 24,
  total: 0,
  totalPages: 1,
  categories: [],
  dimensions: [],
};

export function useAssetLibraryCatalog(projectId: string | undefined, onImported: () => Promise<void>) {
  const [search, setSearch] = useState("");
  const [dimension, setDimension] = useState<AssetLibraryDimension | "all">("all");
  const [category, setCategory] = useState("all");
  const [featuredOnly, setFeaturedOnly] = useState(true);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AssetLibraryPage>(EMPTY_PAGE);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string>();
  const [importError, setImportError] = useState<string>();
  const [importingId, setImportingId] = useState<string>();
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setCatalogError(undefined);
    try {
      const next = await api.listAssetLibrary({
        ...(search.trim() ? { search: search.trim() } : {}),
        dimension,
        ...(category !== "all" ? { category } : {}),
        featured: featuredOnly,
        page,
        pageSize: 24,
      });
      if (sequence === requestSequence.current) setResult(next);
    } catch (reason) {
      if (sequence === requestSequence.current) setCatalogError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [category, dimension, featuredOnly, page, search]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), search ? 220 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search]);

  const updateSearch = (value: string) => {
    setSearch(value);
    setPage(1);
  };
  const updateCategory = (value: string) => {
    setCategory(value);
    setPage(1);
  };
  const updateDimension = (value: AssetLibraryDimension | "all") => {
    setDimension(value);
    setCategory("all");
    setPage(1);
  };
  const updateFeaturedOnly = (value: boolean) => {
    setFeaturedOnly(value);
    setPage(1);
  };

  const importItem = async (itemId: string) => {
    if (!projectId || importingId) return;
    setImportingId(itemId);
    setImportError(undefined);
    try {
      await api.importAssetLibraryItem(projectId, itemId);
      await onImported();
    } catch (reason) {
      setImportError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImportingId(undefined);
    }
  };

  return {
    result,
    search,
    dimension,
    category,
    featuredOnly,
    loading,
    catalogError,
    importError,
    importingId,
    setPage,
    updateSearch,
    updateCategory,
    updateDimension,
    updateFeaturedOnly,
    importItem,
    clearImportError: () => setImportError(undefined),
    reload: load,
  };
}
