import type { CSSProperties } from "react";
import type { DashboardPageAppearance } from "@bim-studio/contracts";

export function dashboardBackgroundStyle(
  appearance: DashboardPageAppearance | undefined,
): CSSProperties {
  const fit = appearance?.backgroundImageFit ?? "cover";
  return {
    backgroundColor: appearance?.backgroundColor ?? "#12191d",
    ...(appearance?.backgroundImageUrl
      ? {
          backgroundImage: `url(${JSON.stringify(appearance.backgroundImageUrl)})`,
          backgroundSize:
            fit === "stretch" ? "100% 100%" : fit === "original" ? "auto" : fit,
          backgroundPosition: appearance.backgroundImagePosition ?? "center",
          backgroundRepeat: appearance.backgroundImageRepeat
            ? "repeat"
            : "no-repeat",
        }
      : {}),
  };
}

