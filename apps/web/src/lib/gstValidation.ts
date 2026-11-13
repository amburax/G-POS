const GSTIN_PATTERN = /^(\d{2})[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Why a GSTIN is not well formed (format, state code, check digit), or null. */
export function gstinProblem(raw: string): string | null {
  const gstin = raw.trim().toUpperCase();
  const m = GSTIN_PATTERN.exec(gstin);
  if (!m) return "A GSTIN is 15 characters, like 24ABCDE1234F1Z5.";
  const state = Number(m[1]);
  if (!((state >= 1 && state <= 38) || state === 97)) return "The first two digits must be a valid state code.";
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(gstin[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  const check = GSTIN_CHARS[(36 - (sum % 36)) % 36];
  if (check !== gstin[14]) return "That GSTIN's last character doesn't match — check it for a typo.";
  return null;
}

export const GST_SCHEMES = ["REGULAR", "COMPOSITION"] as const;
export type GstScheme = (typeof GST_SCHEMES)[number];

export const COMPOSITION_NOT_SUPPORTED =
  "Composition scheme isn't supported yet: composition dealers must issue a Bill of Supply and pay tax differently. Contact support.";

/** Why this GST scheme can't be used, or null. Only the regular scheme is supported. */
export function gstSchemeProblem(scheme: GstScheme | undefined): string | null {
  return scheme === "COMPOSITION" ? COMPOSITION_NOT_SUPPORTED : null;
}
