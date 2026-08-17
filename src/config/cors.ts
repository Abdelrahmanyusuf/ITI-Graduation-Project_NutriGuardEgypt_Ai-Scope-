export const GRADUATION_FRONTEND_ORIGINS = [
  "http://localhost:5173",
  "https://nutri-guard-frontend.vercel.app",
] as const;

/** CORS compares URL origins, never full URLs (paths and trailing slashes are irrelevant). */
export function canonicalCorsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function canonicalCorsOrigins(values: readonly string[]): string[] {
  return [...new Set(values.flatMap((value) => {
    const origin = canonicalCorsOrigin(value.trim());
    return origin ? [origin] : [];
  }))];
}
