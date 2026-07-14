/**
 * Poisson mass and cumulative functions. The pmf is computed in log space
 * (subtracting log-factorial) so large k never overflows lambda^k or k!.
 */

function logFactorial(k: number): number {
  let sum = 0;
  for (let i = 2; i <= k; i++) sum += Math.log(i);
  return sum;
}

export function poissonPmf(lambda: number, k: number): number {
  if (!Number.isInteger(k) || k < 0) return 0;
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda + k * Math.log(lambda) - logFactorial(k));
}

export function poissonCdf(lambda: number, k: number): number {
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += poissonPmf(lambda, i);
  return sum;
}
