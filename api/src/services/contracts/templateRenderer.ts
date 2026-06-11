export type TemplateValue = string | number | boolean | null | undefined;

export function renderTemplate(template: string, values: Record<string, TemplateValue>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return match;
    const value = values[key];
    return value == null ? '' : String(value);
  });
}
