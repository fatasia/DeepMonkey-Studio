import type { PointerEvent as ReactPointerEvent } from "react";

export function DashboardRuler({
  orientation,
  length,
  viewportLength,
  zoom,
  offset,
  onPointerDown,
}: {
  orientation: "horizontal" | "vertical";
  length: number;
  viewportLength: number;
  zoom: number;
  offset: number;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const majorStep = zoom >= 0.75 ? 100 : zoom >= 0.35 ? 200 : 500;
  const ticks = Array.from(
    { length: Math.floor(length / majorStep) + 1 },
    (_, index) => index * majorStep,
  );
  return (
    <div
      className={`dashboard-ruler ${orientation}`}
      style={
        orientation === "horizontal"
          ? { width: viewportLength }
          : { height: viewportLength }
      }
      onPointerDown={onPointerDown}
    >
      {ticks.map((position) => (
        <span
          key={position}
          style={
            orientation === "horizontal"
              ? { left: offset + position * zoom }
              : { top: offset + position * zoom }
          }
        >
          <i />
          {position}
        </span>
      ))}
    </div>
  );
}

