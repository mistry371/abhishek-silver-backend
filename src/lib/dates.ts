/** The business operates in India Standard Time (UTC+05:30, no DST). */
const IST_OFFSET_MS = 330 * 60 * 1000;

function istParts(date: Date) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

const fromIst = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day) - IST_OFFSET_MS);

export function startOfIstDay(date = new Date()) {
  const { year, month, day } = istParts(date);
  return fromIst(year, month, day);
}

export function startOfIstMonth(date = new Date()) {
  const { year, month } = istParts(date);
  return fromIst(year, month, 1);
}

/** "YYYY-MM-DD" in IST. */
export function istDate(date = new Date()) {
  const { year, month, day } = istParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Start of an IST calendar date given as "YYYY-MM-DD". */
export function istDateStart(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return fromIst(year!, month!, day!);
}

/** Exclusive end (start of the following day) for an IST calendar date. */
export function istDateEnd(value: string) {
  return new Date(istDateStart(value).getTime() + 24 * 60 * 60 * 1000);
}

/** Indian financial year (April–March), e.g. { label: "2026-27", short: "2627" }. */
export function financialYear(date = new Date()) {
  const { year, month } = istParts(date);
  const start = month >= 4 ? year : year - 1;
  const two = (value: number) => String(value % 100).padStart(2, "0");
  return { start, label: `${start}-${two(start + 1)}`, short: `${two(start)}${two(start + 1)}` };
}

/** "YYMM" in IST, used in order numbers. */
export function yearMonthStamp(date = new Date()) {
  const { year, month } = istParts(date);
  return `${String(year % 100).padStart(2, "0")}${String(month).padStart(2, "0")}`;
}
