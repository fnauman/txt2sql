#!/usr/bin/env node

import { getPositionalArgs, loadEnvironment } from '../src/env.js';
import {
  buildSemanticPlan,
  createMariaDbConnection,
  describeMariaDbConnectionTarget,
} from '../src/pipeline.js';
import { resolveMasterDataCandidates } from '../src/master-data-resolver.js';
import { createTimer } from '../src/trace.js';

async function main() {
  const argv = process.argv.slice(2);
  await loadEnvironment(argv);
  const question = getPositionalArgs(argv, ['--env-file', '--env-dir']).join(' ').trim();

  if (!question) {
    throw new Error('Pass a question to resolve, for example: npm run resolve-master-data -- "sparkling water sales"');
  }

  const connection = await createMariaDbConnection();
  try {
    const semanticPlan = buildSemanticPlan(question);
    const timer = createTimer();
    const candidates = await resolveMasterDataCandidates({
      connection,
      semanticPlan,
    });
    const timing = timer.stop();

    console.log(
      JSON.stringify(
        {
          target: describeMariaDbConnectionTarget(),
          question,
          durationMs: timing.durationMs,
          candidates,
        },
        null,
        2
      )
    );
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(`Master-data resolution failed: ${error.message}`);
  process.exitCode = 1;
});
