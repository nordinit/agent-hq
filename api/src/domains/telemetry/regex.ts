import { RE2JS } from 're2js';

export const MAX_REGEX_LENGTH = 512;
const compiled = new Map<string, RE2JS>();

/** Shared by the API and Explorer; bounded patterns use a non-backtracking engine. */
export function compileTelemetryRegex(pattern: unknown, flags: unknown = ''): RE2JS {
  if (typeof pattern !== 'string' || pattern.length > MAX_REGEX_LENGTH) {
    throw new Error(`Regex must be a string of at most ${MAX_REGEX_LENGTH} characters.`);
  }
  if (typeof flags !== 'string' || flags.length > 3 || new Set(flags).size !== flags.length || [...flags].some(flag => !'ims'.includes(flag))) {
    throw new Error('Regex flags may contain i (ignore case), m (multiline), and s (dot matches newline), once each.');
  }
  const key = JSON.stringify([pattern, flags]);
  const cached = compiled.get(key);
  if (cached) return cached;
  const options = (flags.includes('i') ? RE2JS.CASE_INSENSITIVE : 0)
    | (flags.includes('m') ? RE2JS.MULTILINE : 0)
    | (flags.includes('s') ? RE2JS.DOTALL : 0);
  let result: RE2JS;
  try { result = RE2JS.compile(pattern, options); }
  catch (error) { throw new Error(`Invalid regex: ${error instanceof Error ? error.message : String(error)}`); }
  if (result.programSize() > 4096) throw new Error('Regex is too complex. Reduce the pattern or repetition counts.');
  if (compiled.size >= 128) compiled.delete(compiled.keys().next().value!);
  compiled.set(key, result);
  return result;
}
