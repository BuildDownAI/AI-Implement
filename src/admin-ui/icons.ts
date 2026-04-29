export const iconRegistry: Record<string, string> = {};
export function icon(name: string, size = 14): string {
  const paths = iconRegistry[name] ?? "";
  return `<svg class="svg-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75">${paths}</svg>`;
}
