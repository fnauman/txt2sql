#!/usr/bin/env node

import { ENV_OPTIONS_WITH_VALUES, ENV_USAGE, getPositionalArgs, loadEnvironment } from '../src/env.js';
import {
  buildSemanticPlan,
  createMariaDbConnection,
  describeMariaDbConnectionTarget,
  resolveStatementTimeoutMs,
} from '../src/pipeline.js';
import { resolveMasterDataCandidates } from '../src/master-data-resolver.js';
import { createTimer } from '../src/trace.js';

async function main() {
  const argv = process.argv.slice(2);
  await loadEnvironment(argv);
  const statementTimeoutMs = resolveStatementTimeoutMs();
  const question = getPositionalArgs(argv, [...ENV_OPTIONS_WITH_VALUES]).join(' ').trim();

  if (!question) {
    throw new Error(
      `Pass a question to resolve, for example: npm run resolve-master-data -- "sparkling water sales"\n${ENV_USAGE}`
    );
  }

  const connection = await createMariaDbConnection();
  try {
    const semanticPlan = buildSemanticPlan(question);
    const timer = createTimer();
    const candidates = await resolveMasterDataCandidates({
      connection,
      semanticPlan,
      statementTimeoutMs,
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
