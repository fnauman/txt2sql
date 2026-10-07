// A preload (node --import) for running scripts/basic.js and
// scripts/optimized.js in tests with no database and no LLM: src/pipeline.js
// is served with its MariaDB connection, privilege report and OpenAI client
// replaced by offline fakes (every other export is the real one). The fake
// client fails every call, so nothing leaves the machine. The schema is
// compiled in memory, so the scripts never write generated/schema.json.
import { registerHooks } from 'node:module';

const FAKES = `
import { DEFAULT_INCLUDED_TABLES } from './constants.js';
import { compileSchemaFromModelsDir, filterSchema } from './schema-compiler.js';

export async function loadNarrowSchema({ modelsDir, includedTables = DEFAULT_INCLUDED_TABLES }) {
  return filterSchema(await compileSchemaFromModelsDir(modelsDir), includedTables);
}
export async function createMariaDbConnection() {
  return { query: async () => [[], []], end: async () => {} };
}
export async function reportQueryUserPrivileges() {}
export function createOpenAiClient() {
  const create = async () => {
    throw Object.assign(new Error('offline test client: no LLM call is made'), { status: 400, code: 'OFFLINE_TEST_CLIENT' });
  };
  return { chat: { completions: { create } } };
}
`;

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/src/pipeline.js')) {
      // A local export shadows the same name from `export *`.
      return { format: 'module', source: `export * from ${JSON.stringify(`${url}?real`)};\n${FAKES}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
