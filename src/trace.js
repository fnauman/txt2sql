import fs from 'node:fs/promises';
import path from 'node:path';
import { Console } from 'node:console';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { getOptionValue, hasOptionFlag } from './env.js';

function roundDurationMs(value) {
  return Number(value.toFixed(3));
}

function createStreamWriter(stream) {
  return async (line) =>
    new Promise((resolve, reject) => {
      stream.write(line, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
}

export function createTimer() {
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();

  return {
    stop() {
      return {
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: roundDurationMs(performance.now() - startedMs),
      };
    },
  };
}

export function serializeError(error) {
  if (!error) {
    return {
      name: 'Error',
      message: 'Unknown error',
    };
  }

  const serialized = {
    name: error.name || 'Error',
    message: error.message || String(error),
    code: error.code || null,
    stack: error.stack || null,
  };
  // Validation errors say which layer rejected the SQL ('safety' or
  // 'guardrail'), and a failure may carry the pipeline stage it stopped in;
  // keep both so traces can be filtered the same way the API reports them.
  if (typeof error.layer === 'string' && error.layer) {
    serialized.layer = error.layer;
  }
  // LlmResponseError names it `stage`; results and API payloads `errorStage`.
  const stage = error.errorStage || error.stage;
  if (typeof stage === 'string' && stage) {
    serialized.errorStage = stage;
  }
  return serialized;
}

export function resolveTraceOptions(argv = process.argv.slice(2)) {
  const filePath = getOptionValue(argv, '--trace-file');
  const logToStdout = hasOptionFlag(argv, '--trace');

  return {
    enabled: logToStdout || Boolean(filePath),
    logToStdout,
    filePath: filePath ? path.resolve(filePath) : null,
  };
}

export function createCliOutput({
  traceToStdout = false,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const stream = traceToStdout ? stderr : stdout;
  const writer = new Console({
    stdout: stream,
    stderr: stream,
  });

  return {
    stream,
    log(...args) {
      writer.log(...args);
    },
    error(...args) {
      writer.error(...args);
    },
    table(...args) {
      writer.table(...args);
    },
    write(text) {
      stream.write(text);
    },
  };
}

export async function createTraceLogger({
  enabled = false,
  logToStdout = false,
  filePath = null,
  pipeline = 'unknown',
  stream = process.stdout,
  runId = randomUUID(),
  metadata = {},
} = {}) {
  const resolvedFilePath = filePath ? path.resolve(filePath) : null;
  const active = enabled || logToStdout || Boolean(resolvedFilePath);
  const writers = [];

  if (resolvedFilePath) {
    await fs.mkdir(path.dirname(resolvedFilePath), { recursive: true });
    writers.push((line) => fs.appendFile(resolvedFilePath, line, 'utf8'));
  }

  if (logToStdout) {
    writers.push(createStreamWriter(stream));
  }

  async function emit(event, payload = {}) {
    if (!active) {
      return;
    }

    const line = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      pipeline,
      runId,
      event,
      ...metadata,
      ...payload,
    })}\n`;

    for (const write of writers) {
      await write(line);
    }
  }

  return {
    enabled: active,
    pipeline,
    runId,
    filePath: resolvedFilePath,
    emit,
  };
}
