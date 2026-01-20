// =============================================================================
// Simple template engine for readable prompts
// =============================================================================

/**
 * Replace {{placeholder}} with values from vars object.
 * Missing keys become empty string. Trims trailing whitespace from result.
 */
export function render(
  template: string,
  vars: Record<string, string | number | undefined>,
): string {
  return template
    .replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const value = vars[key];
      return value !== undefined ? String(value) : '';
    })
    .replace(/\n{3,}/g, '\n\n') // Collapse multiple blank lines
    .trim();
}

/**
 * Join non-empty lines with newlines.
 * Filters out undefined/empty strings.
 */
export function joinLines(...parts: (string | undefined)[]): string {
  return parts.filter((p) => p && p.trim()).join('\n');
}

/**
 * Wrap content in a section if it's non-empty, otherwise return empty string.
 */
export function section(content: string | undefined): string {
  return content?.trim() || '';
}
