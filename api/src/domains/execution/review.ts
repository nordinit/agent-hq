/**
 * A revision snapshot as reviewers may see it: secret references keep only their id and digest,
 * credential-like fields and environment or header values are redacted.
 */
export function reviewSnapshot(value: any, key = ''): any {
    if(value&&typeof value==='object'&&typeof value.$secret_ref==='string')return {$secret_ref:value.$secret_ref,digest:value.digest};
    if (/(?:secret|token|password|credential|auth_header|api_key)/i.test(key))
        return '[redacted]';
    if (['env', 'headers'].includes(key) && value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,v&&typeof v==='object'&&'$secret_ref' in v?reviewSnapshot(v):'[redacted; digest bound]']));
    if (Array.isArray(value))
        return value.map(v => reviewSnapshot(v));
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, reviewSnapshot(v, k)]));
    if (key === 'implementation_body' && typeof value === 'string') {
        try {
            return JSON.stringify(reviewSnapshot(JSON.parse(value)));
        }
        catch {
            return value;
        }
    }
    return value;
}
