// Apply the same tolerated miss rate to fixture-design and later-authored
// controls. This policy is independent of the current suite's measured rates.
export const DEFAULT_MIN_KILL_RATE = 0.95;
export const DEFAULT_MIN_HELDOUT_KILL_RATE = 0.95;
export const ORACLE_POLICY_VERSION = 'oracle-controls-v2';

export function resolveOraclePolicy({ name = 'strict', minKillRate = null, minHeldoutKillRate = null } = {}) {
  if (!['strict', 'regression'].includes(name)) {
    throw new Error('--oracle-policy must be strict or regression.');
  }
  const design = minKillRate ?? DEFAULT_MIN_KILL_RATE;
  const heldout = minHeldoutKillRate ?? (name === 'regression' ? 0 : DEFAULT_MIN_HELDOUT_KILL_RATE);
  for (const value of [design, heldout]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Oracle kill-rate floors must be between 0 and 1.');
  }
  if (name === 'strict' && (design < DEFAULT_MIN_KILL_RATE || heldout < DEFAULT_MIN_HELDOUT_KILL_RATE)) {
    throw new Error('The strict oracle policy requires both kill-rate floors to be at least 0.95; use --oracle-policy regression for a diagnostic comparison.');
  }
  return { version: ORACLE_POLICY_VERSION, name, minKillRate: design, minHeldoutKillRate: heldout, baselineEligible: name === 'strict' };
}

export function oraclePolicyNotice(policy) {
  return policy.name === 'regression'
    ? 'Oracle policy: regression (diagnostic only; cannot promote a baseline or establish oracle quality).'
    : `Oracle policy: strict (design and held-out control floors ${(policy.minKillRate * 100).toFixed(1)}% / ${(policy.minHeldoutKillRate * 100).toFixed(1)}%).`;
}
