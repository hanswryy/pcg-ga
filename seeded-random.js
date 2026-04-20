// A simple linear congruential generator (LCG) for seeded random numbers.
let seed = 0;

/**
 * Sets the seed for the random number generator.
 * @param {number} newSeed - The new seed.
 */
export function setSeed(newSeed) {
  seed = newSeed;
}

/**
 * Returns a pseudo-random number between 0 and 1.
 * @returns {number} A random number.
 */
export function random() {
  const a = 1664525;
  const c = 1013904223;
  const m = 2**32;
  seed = (a * seed + c) % m;
  return seed / m;
}
