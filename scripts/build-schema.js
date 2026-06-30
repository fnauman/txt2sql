import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getOptionValue, hasOptionFlag } from '../src/env.js';
import { compileSchemaFromModelsDir, writeSchemaFile } from '../src/schema-compiler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODELS_DIR = path.resolve(__dirname, '../models');
const DEFAULT_OUTPUT = path.resolve(__dirname, '../generated/schema.json');

async function main() {
  const argv = process.argv.slice(2);
  const modelsDir = path.resolve(getOptionValue(argv, '--models-dir') || DEFAULT_MODELS_DIR);
  const outputPath = path.resolve(getOptionValue(argv, '--out') || DEFAULT_OUTPUT);
  const verbose = hasOptionFlag(argv, '--verbose');

  const schema = await compileSchemaFromModelsDir(modelsDir);
  await writeSchemaFile(schema, outputPath);

  console.log(`Schema written to ${outputPath}`);
  console.log(`Tables parsed: ${schema.tableCount}`);
  console.log(`Missing referenced models ignored: ${schema.missingReferencedModels.length}`);

  if (verbose && schema.missingReferencedModels.length > 0) {
    console.log('\nIgnored FK targets:');
    for (const modelName of schema.missingReferencedModels) {
      console.log(`- ${modelName}`);
    }
  }
}

main().catch((error) => {
  console.error(`Schema build failed: ${error.message}`);
  process.exitCode = 1;
});
