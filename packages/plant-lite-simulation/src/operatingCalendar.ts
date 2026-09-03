import type { Availability, ShiftWindow } from "./model.js";

const DAY_MINUTES = 1_440;

export function isPlantLiteAvailableAt(minute: number, availability: Availability | undefined): boolean {
  const shifts = availability?.shifts;
  if (!shifts?.length) return true;
  const dayMinute = positiveModulo(minute, DAY_MINUTES);
  return shifts.some((shift) => dayMinute >= shift.startMinute && dayMinute < shift.endMinute);
}

/** 将运行分钟换算为日历时间；MTBF 因此不会在休班期间消耗。 */
export function addPlantLiteOperatingMinutes(start: number, operatingMinutes: number, availability: Availability | undefined): number {
  if (!availability?.shifts?.length) return start + operatingMinutes;
  const shifts = mergeShiftWindows(availability.shifts);
  let cursor = Math.max(0, start);
  let remaining = Math.max(0, operatingMinutes);
  while (remaining > 0) {
    const day = Math.floor(cursor / DAY_MINUTES);
    const dayStart = day * DAY_MINUTES;
    let advanced = false;
    for (const shift of shifts) {
      const shiftStart = dayStart + shift.startMinute;
      const shiftEnd = dayStart + shift.endMinute;
      if (cursor >= shiftEnd) continue;
      cursor = Math.max(cursor, shiftStart);
      const available = shiftEnd - cursor;
      if (remaining <= available) return cursor + remaining;
      remaining -= available;
      cursor = shiftEnd;
      advanced = true;
    }
    if (!advanced || cursor < (day + 1) * DAY_MINUTES) cursor = (day + 1) * DAY_MINUTES;
  }
  return cursor;
}

export function unionPlantLiteAvailabilities(values: Array<Availability | undefined>): Availability | undefined {
  if (!values.length || values.some((value) => !value?.shifts?.length)) return undefined;
  const shifts = mergeShiftWindows(values.flatMap((value) => value?.shifts ?? []));
  return shifts.length ? { shifts } : undefined;
}

function mergeShiftWindows(shifts: ShiftWindow[]): ShiftWindow[] {
  const sorted = [...shifts].sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute);
  const merged: ShiftWindow[] = [];
  for (const shift of sorted) {
    const previous = merged.at(-1);
    if (!previous || shift.startMinute > previous.endMinute) merged.push({ ...shift });
    else previous.endMinute = Math.max(previous.endMinute, shift.endMinute);
  }
  return merged;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
