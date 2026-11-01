export function configError(message) {
  const error = new Error(message);
  error.code = 'INVALID_CONFIG';
  return error;
}

export function readIntegerEnv(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }

  // Plain decimal digits only (Number() would also take "0x50" or "8e3").
  const text = String(raw).trim();
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw configError(`${name} must be an integer between ${min} and ${max}; got "${raw}".`);
  }

  return value;
}

