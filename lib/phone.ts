/** Normalise Indian phone numbers to E.164 so repeat-caller matching is reliable. */
export function toE164(raw: string, defaultCountry = "91"): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  const d = digits.replace(/^0+/, "");
  if (d.length === 10) return `+${defaultCountry}${d}`;
  if (d.startsWith(defaultCountry) && d.length === 12) return `+${d}`;
  return `+${d}`;
}
