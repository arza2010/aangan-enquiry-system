/**
 * Hard rule #1: no price figure may reach a designer-facing note or the CRM.
 * Deliberately over-eager: a false positive costs one retry, a miss breaks the rule.
 */
const PRICE_PATTERNS: RegExp[] = [
  /₹/,
  /\brs\.?\s*\d/i,
  /\brs\b/i,
  /\binr\b/i,
  /\brupees?\b/i,
  /\blakhs?\b/i,
  /\blacs?\b/i,
  /\bcrores?\b/i,
  /\bper\s*sq/i,
  /\/\s*sq/i,
  /\bsq\.?\s*ft\.?\s*(rate|price|cost)/i,
  /\d\s*(k|l|lk|cr)\b(?=\s|$|[.,;])/i,
  /\d[\d,.]*\s*(rupees?|rs|inr|lakhs?|lacs?|crores?)\b/i,
];

export function findPriceLeaks(text: string): string[] {
  return PRICE_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
}

export function hasPriceLeak(text: string): boolean {
  return findPriceLeaks(text).length > 0;
}

/** Last resort if the model keeps leaking: strip the offending phrases rather than ship them. */
export function redactPrices(text: string): string {
  return text
    .replace(/₹\s*[\d,.]+(\s*(-|–|to)\s*[\d,.]+)?\s*(lakhs?|lacs?|crores?|k|l|cr)?/gi, "[figure removed]")
    .replace(/[\d,.]+(\s*(-|–|to)\s*[\d,.]+)?\s*(lakhs?|lacs?|crores?|rupees?|rs\.?|inr)\b/gi, "[figure removed]")
    .replace(/\bper\s*sq\.?\s*(ft|foot|feet)\b/gi, "[rate removed]")
    .replace(/[₹]/g, "")
    .replace(/\b(lakhs?|lacs?|crores?)\b/gi, "[figure removed]");
}
