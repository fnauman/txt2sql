// Small seeded PRNG for the deterministic fixture generator. mulberry32: a
// 32-bit state, full period over its state space, and identical output on
// every platform (only 32-bit integer math via Math.imul and >>>), which is
// what a reproducible fixture needs. Not for anything security-related.

export function createPrng(seed) {
  let state = Number(seed) >>> 0;

  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  const prng = {
    /** Uniform float in [0, 1). */
    next,
    /** Uniform integer in [min, max] (inclusive). */
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    /** True with probability p. */
    chance(p) {
      return next() < p;
    },
    /** A uniformly chosen element. */
    pick(values) {
      return values[Math.floor(next() * values.length)];
    },
    /** An element chosen by weight: entries are [value, weight]. */
    weighted(entries) {
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
      let roll = next() * total;
      for (const [value, weight] of entries) {
        roll -= weight;
        if (roll < 0) {
          return value;
        }
      }
      return entries[entries.length - 1][0];
    },
  };
  return prng;
}
