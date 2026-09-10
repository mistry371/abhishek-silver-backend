/** Normalises an Indian mobile number to 10 digits, or returns null when invalid. */
export function normalizeIndianMobile(value: string | null | undefined): string | null {
  if (!value) return null;
  let digits = value.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

export const toE164 = (mobile: string) => `+91${mobile}`;
