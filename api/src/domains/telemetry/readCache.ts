import type { Db } from '../../db/adapter/types';
import { contentHash } from './catalog';

/** Owned by one repeatable-read evaluation, never shared across requests/users.
 * Cache raw SELECT results: metrics still normalize their own pinned fields and
 * calculate their own coverage, populations and denominators.
 */
export type TelemetryReadCache = Map<string, Promise<any>>;
export function cachedTelemetryReads(db: Db, cache: TelemetryReadCache): Db {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'all' || property === 'get' || property === 'value') {
        return (sql: string, ...params: unknown[]) => {
          const key = contentHash({ method: property, sql, params });
          let result = cache.get(key);
          if (!result) {
            result = target[property](sql, ...params).catch(error => { cache.delete(key); throw error; });
            cache.set(key, result);
          }
          return result;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
