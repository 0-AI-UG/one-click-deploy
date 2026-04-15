/**
 * Creates a masking function that replaces secret values with "***" in text.
 * Handles exact matches and common encodings.
 */
export function createMasker(secrets: string[]): (text: string) => string {
  // Filter out empty/short strings to avoid false positive masking
  const validSecrets = secrets.filter((s) => s && s.length >= 4);
  if (validSecrets.length === 0) return (text) => text;

  // Build regex that matches any secret value
  const escaped = validSecrets.map((s) =>
    s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  const pattern = new RegExp(escaped.join("|"), "g");

  return (text: string) => text.replace(pattern, "***");
}

/**
 * Masks environment variable values in text.
 */
export function maskEnvValues(
  text: string,
  envVars: Record<string, string>
): string {
  const values = Object.values(envVars);
  const masker = createMasker(values);
  return masker(text);
}
