type CronField = { values: Set<number>; wildcard: boolean };

const monthNames = Object.fromEntries(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].map((name, index) => [name, index + 1]));
const weekdayNames = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((name, index) => [name, index]));

function fieldValue(value: string, names: Record<string, number>): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  return names[value.toLowerCase()];
}

function parseField(expression: string, min: number, max: number, names: Record<string, number> = {}, question = false, sunday = false): CronField | undefined {
  const values = new Set<number>();
  let wildcard = false;
  const members = expression.split(',');
  if (!members.length || members.some((member) => !member)) return undefined;

  for (const member of members) {
    const stepParts = member.split('/');
    if (stepParts.length > 2) return undefined;
    const step = stepParts.length === 2 ? Number(stepParts[1]) : 1;
    if (!Number.isInteger(step) || step < 1 || step > max - min + 1) return undefined;
    const base = stepParts[0];
    if (base === undefined) return undefined;
    let start: number;
    let end: number;
    if (base === '*' || (question && base === '?')) {
      wildcard = true;
      start = min;
      end = max;
    } else {
      const range = base.split('-');
      if (range.length > 2 || range.some((part) => part === '')) return undefined;
      const rangeStart = range[0];
      const rangeEnd = range[1];
      if (rangeStart === undefined || (range.length === 2 && rangeEnd === undefined)) return undefined;
      const first = fieldValue(rangeStart, names);
      const last = range.length === 2 ? fieldValue(rangeEnd as string, names) : (stepParts.length === 2 ? max : first);
      if (first === undefined || last === undefined || first < min || first > max || last < min || last > max || first > last) return undefined;
      start = first;
      end = last;
    }
    for (let value = start; value <= end; value += step) {
      values.add(sunday && value === 7 ? 0 : value);
    }
  }
  return values.size ? { values, wildcard } : undefined;
}

export function nextCronOccurrence(expression: string, after = new Date()): Date | undefined {
  if (!Number.isFinite(after.getTime())) return undefined;
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const [minutePart, hourPart, dayOfMonthPart, monthPart, dayOfWeekPart] = parts;
  if (!minutePart || !hourPart || !dayOfMonthPart || !monthPart || !dayOfWeekPart) return undefined;
  const minute = parseField(minutePart, 0, 59);
  const hour = parseField(hourPart, 0, 23);
  const dayOfMonth = parseField(dayOfMonthPart, 1, 31, {}, true);
  const month = parseField(monthPart, 1, 12, monthNames);
  const dayOfWeek = parseField(dayOfWeekPart, 0, 7, weekdayNames, true, true);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return undefined;

  const afterMs = after.getTime();
  const start = Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate());
  for (let day = 0; day <= 366 * 8; day += 1) {
    const date = new Date(start + day * 86_400_000);
    const monthMatches = month.values.has(date.getUTCMonth() + 1);
    const dateMatches = dayOfMonth.values.has(date.getUTCDate());
    const weekdayMatches = dayOfWeek.values.has(date.getUTCDay());
    const calendarMatches = dayOfMonth.wildcard && dayOfWeek.wildcard
      ? true
      : dayOfMonth.wildcard ? weekdayMatches
        : dayOfWeek.wildcard ? dateMatches : dateMatches || weekdayMatches;
    if (!monthMatches || !calendarMatches) continue;

    for (const hourValue of [...hour.values].sort((a, b) => a - b)) {
      for (const minuteValue of [...minute.values].sort((a, b) => a - b)) {
        const candidate = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hourValue, minuteValue);
        if (candidate > afterMs) return new Date(candidate);
      }
    }
  }
  return undefined;
}
