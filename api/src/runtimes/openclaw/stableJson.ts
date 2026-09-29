/** Object order is not configuration; array order can be (notably command args). */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, child) => {
    if (!child || typeof child !== 'object' || Array.isArray(child)) return child;
    return Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]]));
  });
}
