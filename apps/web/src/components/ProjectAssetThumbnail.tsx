import { useEffect, useRef, useState } from "react";
import { Box, ImageOff, Mountain, Paintbrush, Video } from "lucide-react";
import type { ModelRecord, ProjectAssetRecord } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { AssetThumbnail } from "./AssetThumbnail";

export function ProjectAssetThumbnail({ item, locale }: { item: ModelRecord | ProjectAssetRecord; locale: AppLocale }) {
  const host = useRef<HTMLSpanElement>(null);
  const [generated, setGenerated] = useState<string>();
  const model = "status" in item;
  const provided = item.thumbnailUrl ?? (!model && item.kind === "image" ? item.url : undefined);
  useEffect(() => {
    setGenerated(undefined);
    if (provided || !host.current) return;
    const definition = model ? item.status === "ready" && item.manifest?.viewerKind === "gltf" && item.manifest.geometryUrl ? { kind: "model" as const, url: item.manifest.geometryUrl } : undefined
      : item.kind === "environment" || item.kind === "pbr-material" ? { kind: item.kind, url: item.url, ...(item.maps ? { maps: item.maps } : {}) } : undefined;
    if (!definition) return;
    let closed = false;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void import("./projectResourceThumbnail").then(module => closed ? undefined : module.projectResourceThumbnail(definition, `${item.projectId}:${item.id}:${item.updatedAt}`)).then(url => { if (!closed) setGenerated(url); });
    }, { rootMargin: "80px" });
    observer.observe(host.current);
    return () => { closed = true; observer.disconnect(); };
  }, [item.id, item.updatedAt, provided]);
  const src = provided ?? generated;
  const Icon = model ? Box : item.kind === "video" ? Video : item.kind === "environment" ? Mountain : item.kind === "pbr-material" ? Paintbrush : ImageOff;
  return <span ref={host} className="project-resource-thumbnail-content">
    {src ? <AssetThumbnail key={src} locale={locale} name={item.name} src={src} /> : !model && item.kind === "video" ? <video src={item.url} muted preload="metadata" aria-label={item.name} /> : <Icon size={36} strokeWidth={1.3} />}
  </span>;
}
