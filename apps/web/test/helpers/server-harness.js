// Test harness for the API server: a real Express app on an ephemeral port,
// driven over HTTP, with fake runtimes instead of MariaDB/OpenAI.
import { once } from 'node:events';
import http from 'node:http';

import { inferColumns } from '../../../../src/result-intelligence.js';
import { loadWebConfig } from '../../src/server/config.js';
import { createApp } from '../../src/server/index.js';

export const silentLogger = { log() {}, warn() {}, error() {} };

export function testConfig(overrides = {}) {
  return loadWebConfig({
    WEB_API_PORT: '0',
    DB_NAME: 'demo_retail',
    DB_USER: 'demo_readonly',
    OPENAI_API_KEY: 'sk-test',
    ...overrides,
  });
}

export const READONLY_GRANTS = [
  "GRANT USAGE ON *.* TO `demo_readonly`@`%` IDENTIFIED BY PASSWORD '*0000'",
  'GRANT SELECT ON `demo\\_retail%`.* TO `demo_readonly`@`%`',
];

// A runtime with the same shape loadOptimizedQueryRuntime returns. `tablesInDb`
// (a function or array) controls what information_schema reports.
export function createFakeRuntime({ id = 1, tables = ['Customer', 'Product'], tablesInDb = null, grants = READONLY_GRANTS } = {}) {
  const runtime = {
    id,
    model: 'fake-model',
    schema: {
      tableCount: tables.length,
      tables: tables.map((tableName) => ({
        name: tableName,
        tableName,
        columns: [],
        foreignKeys: [],
        ignoredForeignKeys: [],
      })),
    },
    client: { id },
    closed: 0,
    queries: [],
    connection: {
      async query(sql, params) {
        runtime.queries.push({ sql, params });
        if (/information_schema\.TABLES/.test(sql)) {
          const present = typeof tablesInDb === 'function' ? tablesInDb() : tablesInDb || tables;
          return [present.map((TABLE_NAME) => ({ TABLE_NAME }))];
        }
        if (/^SELECT 1 AS ok$/.test(sql)) {
          return [[{ ok: 1 }]];
        }
        if (/^SHOW GRANTS$/.test(sql)) {
          return [grants.map((grant) => ({ 'Grants for demo_readonly@%': grant }))];
        }
        return [[]];
      },
    },
    async close() {
      runtime.closed += 1;
    },
  };
  return runtime;
}

// Records factory calls and hands out numbered fake runtimes.
export function createRuntimeFactory(options = {}) {
  const calls = [];
  const runtimes = [];
  const factory = async (factoryOptions) => {
    calls.push(factoryOptions);
    if (options.fail?.(calls.length)) {
      throw options.error || Object.assign(new Error('OPENAI_API_KEY is required.'), { code: 'OPENAI_NOT_CONFIGURED' });
    }
    const runtime = createFakeRuntime({ ...options, id: runtimes.length + 1 });
    runtimes.push(runtime);
    return runtime;
  };
  return { factory, calls, runtimes };
}

export function successResult(question, rows = [{ CustomerName: 'North District Market', total: 1000 }], extra = {}) {
  return {
    success: true,
    question,
    sql: 'SELECT CustomerName, SUM(NetAmount) AS total FROM Customer',
    rows,
    columns: inferColumns(rows),
    visualizations: [],
    insights: [],
    response: { explanation: 'Totals by customer.', tables_used: ['Customer'], assumptions: [], rawText: '{"raw":true}' },
    errorStage: null,
    errorCode: null,
    llmCalls: [{ attempt: 1 }],
    llmUsage: { total_tokens: 10 },
    llmCost: { totalCost: 0.0001, currency: 'USD' },
    promptTables: ['Customer'],
    masterDataCandidates: [],
    attemptCount: 1,
    rowCount: rows.length,
    totalRowCount: rows.length,
    truncated: false,
    ...extra,
  };
}

export function failureResult(question, { stage, code = null, message = 'failed', name = 'Error' }) {
  const error = Object.assign(new Error(message), { name, ...(code ? { code } : {}) });
  return {
    success: false,
    question,
    sql: '',
    rows: [],
    columns: [],
    visualizations: [],
    insights: [],
    response: null,
    error,
    errorStage: stage,
    errorCode: code,
    serializedError: { name, message, code, stack: 'Error: failed\n    at secret (/abs/path.js:1:1)' },
    llmCalls: [],
    llmUsage: null,
    llmCost: null,
    promptTables: [],
    masterDataCandidates: [],
    attemptCount: 1,
    rowCount: 0,
    totalRowCount: 0,
    truncated: false,
  };
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on('error', reject);
    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

export function parseSse(text) {
  return text
    .split('\n\n')
    .map((chunk) => {
      const event = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      return event ? { event, data: data ? JSON.parse(data) : null } : null;
    })
    .filter(Boolean);
}

export async function startApp(options = {}) {
  const instance = createApp({ logger: silentLogger, ...options });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    ...instance,
    server,
    port,
    request: (requestOptions) => request(port, requestOptions),
    async stop() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await instance.close();
    },
  };
}
