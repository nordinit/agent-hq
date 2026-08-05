const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function quoteCsvString(value) {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Encode one SQLite value for PostgreSQL COPY CSV.
 *
 * SQLite can return a Buffer even from a TEXT-affinity column because its value typing is
 * dynamic. Only a declared BLOB column maps to PostgreSQL bytea. A Buffer found in any other
 * column must be decoded as UTF-8 text, or rejected if it is not valid UTF-8, rather than
 * written as a literal "\x..." string into a PostgreSQL text column.
 */
export function csvCell(value, declaredType = '', context = 'value') {
  if (value === null || value === undefined) return '';
  if (Buffer.isBuffer(value)) {
    if (/\bBLOB\b/i.test(String(declaredType))) return `"\\x${value.toString('hex')}"`;
    try {
      return quoteCsvString(utf8Decoder.decode(value));
    } catch {
      throw new Error(`${context} contains non-UTF-8 bytes in a non-BLOB SQLite column`);
    }
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return quoteCsvString(String(value));
}
