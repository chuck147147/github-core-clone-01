// Deterministic identity stream, ported from the scenario wire contract.
const U64_MASK = (1n << 64n) - 1n;
export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
export interface ScenarioUser { id: number; login: string; name: string; email: string }
export function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer: a seeded value with every bit mixed into every other. */
export function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** The seed a named stream starts from: a stable function of SCENARIO_SEED and the label. */
export function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** A named stream: same label, same numbers, in any process and any order of use. */
export function scenarioRng(label: string): Rng {
  return new Rng(scenarioSeedFor(label));
}

const HEX_DIGITS = '0123456789abcdef';

/**
 * xorshift64*: a 64-bit state walked by three shifts and one multiply, seeded from a bigint. Every
 * method is deterministic and has no hidden state but `#state`; clone() gives an independent stream
 * from the same point. Never seeded from a clock or Math.random.
 */
export class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  /** A stream from a label (scenarioSeedFor) under this scenario's seed. */
  static fromLabel(label: string): Rng {
    return new Rng(scenarioSeedFor(label));
  }

  /** An independent stream from this one's current state. */
  clone(): Rng {
    return new Rng(this.#state);
  }

  /** The next 64-bit value. */
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  /** The next 32-bit value, from the top half of nextU64(). */
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, maxExclusive), unbiased by rejection. */
  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) throw new Error(`nextInt needs a positive safe integer, not ${String(maxExclusive)}`);
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  /** A number in [0, 1), 32 bits of resolution. */
  fraction(): number {
    return this.nextU32() / 4_294_967_296;
  }

  /** True with probability `probability`. */
  chance(probability: number): boolean {
    return this.fraction() < probability;
  }

  /** One element, uniformly (a Error on an empty list). */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from an empty list');
    return items[this.nextInt(items.length)];
  }

  /** A shuffled copy, Fisher-Yates. */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(i + 1);
      const swap = copy[i];
      copy[i] = copy[j];
      copy[j] = swap;
    }
    return copy;
  }

  /** `length` bytes. */
  bytes(length: number): Uint8Array {
    const size = Number.isSafeInteger(length) ? Math.max(0, length) : 0;
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i += 4) {
      const word = this.nextU32();
      out[i] = word & 0xff;
      if (i + 1 < size) out[i + 1] = (word >>> 8) & 0xff;
      if (i + 2 < size) out[i + 2] = (word >>> 16) & 0xff;
      if (i + 3 < size) out[i + 3] = (word >>> 24) & 0xff;
    }
    return out;
  }

  /** `length` lowercase hex characters. */
  hex(length: number): string {
    let out = '';
    while (out.length < length) out += HEX_DIGITS[this.nextInt(16)];
    return out;
  }

  /** `count` picks from `list`, in order. */
  words(count: number, list: readonly string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < count; i += 1) out.push(this.pick(list));
    return out;
  }
}

// ---------------------------------------------------------------- the seeded scenario (data)

const FIRST_NAMES: readonly string[] = Object.freeze([
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
]);
const LAST_NAMES: readonly string[] = Object.freeze([
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
]);

export function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push(Object.freeze({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` }));
  }
  return users;
}


export const users = generateUsers(scenarioRng('users'), 12);
