// Model configuration: which model a run uses and where that choice came from.
//
// DEFAULT_MODEL is the one default model of the repository: the web server,
// the basic and optimized CLIs, the query service and npm run eval all fall
// back to it when neither --model (eval only) nor MODEL_NAME is set. A test
// (test/model-config.test.js) fails on any other default model literal in
// src/, scripts/, apps/web/src/server/ or the CI workflow, so changing the
// default is a one-line change here.

export const DEFAULT_MODEL = 'gpt-4o-mini';

function nonBlank(value) {
  return value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim();
}

/**
 * The model and its source: `--model` (the flag, eval only), `MODEL_NAME` (the
 * environment, which includes the loaded env file) or `default`
 * (DEFAULT_MODEL). Blank values count as unset.
 */
export function resolveModelName(env = process.env, { flag = null } = {}) {
  const fromFlag = nonBlank(flag);
  if (fromFlag) {
    return { model: fromFlag, source: '--model' };
  }
  const fromEnv = nonBlank(env.MODEL_NAME);
  if (fromEnv) {
    return { model: fromEnv, source: 'MODEL_NAME' };
  }
  return { model: DEFAULT_MODEL, source: 'default' };
}
