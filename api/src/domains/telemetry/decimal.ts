import { DecimalValue, NumericResult } from './contracts';

/** Decimal fixed-point arithmetic. Addition/multiplication never pass through IEEE doubles. */
export class Decimal {
  private constructor(readonly coefficient: bigint, readonly scale: number) {}
  static parse(value: unknown): Decimal | null {
    if (typeof value === 'object' && value !== null && 'decimal' in value) value = (value as DecimalValue).decimal;
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    const match = String(value).match(/^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
    if (!match || match[2].length + (match[3]?.length ?? 0) > 100) return null;
    const exponent = Number(match[4] ?? 0);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;
    let coefficient = BigInt(`${match[1]}${match[2]}${match[3] ?? ''}`);
    let scale = (match[3]?.length ?? 0) - exponent;
    if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
    return Decimal.normalize(coefficient, scale);
  }
  static zero(): Decimal { return new Decimal(0n, 0); }
  static one(): Decimal { return new Decimal(1n, 0); }
  private static normalize(coefficient: bigint, scale: number): Decimal {
    while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale--; }
    return new Decimal(coefficient, scale);
  }
  add(other: Decimal): Decimal {
    const scale = Math.max(this.scale, other.scale);
    return Decimal.normalize(this.coefficient * 10n ** BigInt(scale - this.scale) + other.coefficient * 10n ** BigInt(scale - other.scale), scale);
  }
  subtract(other: Decimal): Decimal { return this.add(new Decimal(-other.coefficient, other.scale)); }
  multiply(other: Decimal): Decimal { return Decimal.normalize(this.coefficient * other.coefficient, this.scale + other.scale); }
  /** Decimal division rounded half away from zero at 24 fractional digits. */
  divide(other: Decimal, precision = 24): Decimal | null {
    if (other.coefficient === 0n) return null;
    const exponent = precision + other.scale - this.scale;
    const numerator = exponent >= 0 ? this.coefficient * 10n ** BigInt(exponent) : this.coefficient;
    const denominator = exponent >= 0 ? other.coefficient : other.coefficient * 10n ** BigInt(-exponent);
    let quotient = numerator / denominator;
    const remainder = numerator % denominator;
    const abs = (n: bigint): bigint => n < 0n ? -n : n;
    if (abs(remainder) * 2n >= abs(denominator)) quotient += (numerator < 0n) !== (denominator < 0n) ? -1n : 1n;
    return Decimal.normalize(quotient, precision);
  }
  compare(other: Decimal): number { const difference = this.subtract(other).coefficient; return difference < 0n ? -1 : difference > 0n ? 1 : 0; }
  toString(): string {
    const negative = this.coefficient < 0n;
    const digits = (negative ? -this.coefficient : this.coefficient).toString().padStart(this.scale + 1, '0');
    return `${negative ? '-' : ''}${this.scale ? `${digits.slice(0, -this.scale)}.${digits.slice(-this.scale)}` : digits}`;
  }
  toNumber(): number { return Number(this.toString()); }
  toJSON(): NumericResult {
    const serialized = this.toString();
    const numeric = Number(serialized);
    // JSON preserves the decimal spelling of ordinary decimals, but not arbitrary precision.
    if (Number.isFinite(numeric) && Math.abs(numeric) <= Number.MAX_SAFE_INTEGER && Decimal.parse(String(numeric))?.compare(this) === 0) return numeric;
    return { decimal: serialized };
  }
}

export function sumDecimals(values: Decimal[]): Decimal { return values.reduce((total, value) => total.add(value), Decimal.zero()); }
