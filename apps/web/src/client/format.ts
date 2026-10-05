// Pure presentation helpers, kept out of App.tsx so they can be unit-tested
// without a DOM or React renderer.

import type { ErrorStage, ValidationLayer } from './types';

export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '-';
  }

  if (typeof value === 'number') {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2 }).format(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  return String(value);
}

export function formatCurrency(value?: number, currency = 'USD'): string {
  if (typeof value !== 'number') {
    return '-';
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 6,
  }).format(value);
}

export function csvField(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Structured context the server sends with a failure: error.code (a stable
// string), the stage the question stopped in, and for a rejected query the
// validator layer. friendlyError classifies on these first.
export interface ErrorContext {
  code?: string | null;
  stage?: ErrorStage | null;
  layer?: ValidationLayer | string | null;
}

const MESSAGES = {
  generic: 'I could not answer that question. Try rephrasing it, or turn on Debug for technical details.',
  empty: 'Something went wrong while answering that question.',
  schemaMissing:
    'The database is not fully set up yet — some demo tables are missing. Ask an administrator to load the data, then try again.',
  unreachable: 'Could not reach the query service. Check that the API server is running, then try again.',
  rateLimited: 'Too many requests in a short time. Please wait a moment and try again.',
  unauthorized: 'You are not authorized to run queries here. Check your access token.',
  unsafe: 'That question could not be answered with a safe, read-only query. Try rephrasing it.',
  invalidQuery:
    'I could not build a valid query for that question against the available tables. Try rephrasing, or turn on Debug to see why.',
  cancelled: 'The question was cancelled before it finished.',
  deadline: 'The question took longer than the server allows and was stopped. Try a narrower question.',
  timedOut: 'The query took too long and was stopped. Try a narrower question, for example a shorter date range.',
  truncated: 'The model ran out of room before finishing its answer. Try a narrower question.',
  refused: 'The model declined to answer that question. Try rephrasing it.',
  modelUnavailable: 'The language model service is not responding right now. Please try again in a moment.',
  modelNotConfigured: 'The model is not configured on the server (no API key). Ask an administrator to set it up.',
  modelFailed: 'The model could not produce an answer. Try again, or rephrase the question.',
  dbNotConfigured: 'The database connection is not configured on the server. Ask an administrator to set it up.',
  execution: 'The database could not run the generated query. Try rephrasing it, or turn on Debug for details.',
  infra: 'The query service or its database is not available right now. Please try again later.',
} as const;

// Codes whose message is already plain and actionable: shown unchanged.
const PASS_THROUGH_CODES = new Set(['QUESTION_TOO_LONG', 'QUESTION_REQUIRED']);

// Provider-side LLM outages (mirrors isLlmUnavailableCode in src/query-service.js).
function isLlmUnavailableCode(code: string): boolean {
  return ['LLM_TIMEOUT', 'LLM_CONNECTION_ERROR', 'HTTP_401', 'HTTP_403', 'HTTP_429'].includes(code) || /^HTTP_5\d\d$/.test(code);
}

function classifyByCode(code: string, message: string): string | null {
  if (PASS_THROUGH_CODES.has(code)) {
    return message || null;
  }
  switch (code) {
    case 'DB_SCHEMA_MISSING':
      return MESSAGES.schemaMissing;
    case 'RATE_LIMITED':
      return MESSAGES.rateLimited;
    case 'UNAUTHORIZED':
      return MESSAGES.unauthorized;
    case 'QUERY_ABORTED':
    case 'LLM_ABORTED':
      return MESSAGES.cancelled;
    case 'REQUEST_TIMEOUT':
      return MESSAGES.deadline;
    case 'ER_STATEMENT_TIMEOUT':
      return MESSAGES.timedOut;
    case 'LLM_TRUNCATED':
      return MESSAGES.truncated;
    case 'LLM_REFUSED':
      return MESSAGES.refused;
    case 'OPENAI_NOT_CONFIGURED':
      return MESSAGES.modelNotConfigured;
    case 'DB_NOT_CONFIGURED':
      return MESSAGES.dbNotConfigured;
    default:
      return isLlmUnavailableCode(code) ? MESSAGES.modelUnavailable : null;
  }
}

function classifyByStage(stage: ErrorStage | null | undefined, layer: string | null | undefined): string | null {
  if (layer === 'safety') {
    return MESSAGES.unsafe;
  }
  if (layer === 'guardrail' || stage === 'validation') {
    return MESSAGES.invalidQuery;
  }
  switch (stage) {
    case 'llm':
      return MESSAGES.modelFailed;
    case 'execution':
      return MESSAGES.execution;
    case 'aborted':
      return MESSAGES.cancelled;
    case 'infra':
      return MESSAGES.infra;
    default:
      return null;
  }
}

// Fallback for failures without structured context (transport errors, older
// servers): match the raw message text.
function classifyByMessage(message: string): string {
  const lower = message.toLowerCase();

  if (/missing expected (?:demo|demo_retail|retail)? tables|databaseschemaerror/.test(lower)) {
    return MESSAGES.schemaMissing;
  }
  if (/failed to fetch|networkerror|econnrefused|fetch failed|load failed|network request failed|could not reach the query service/.test(lower)) {
    return MESSAGES.unreachable;
  }
  if (/characters or fewer|question is required/.test(lower)) {
    return message;
  }
  if (/too many requests|rate limit/.test(lower)) {
    return MESSAGES.rateLimited;
  }
  if (/unauthorized|forbidden|invalid token|missing token/.test(lower)) {
    return MESSAGES.unauthorized;
  }
  if (/only read-only|only select or with|single sql statement|restricted sql functions|are not allowed|executable sql comments/.test(lower)) {
    return MESSAGES.unsafe;
  }
  if (
    /outside the allowed table set|unknown column|unknown table|unknown identifier|not an in-scope relationship|preferred column for semantic metric|resolved master-data|tables_used/.test(
      lower
    )
  ) {
    return MESSAGES.invalidQuery;
  }

  return MESSAGES.generic;
}

// Map a failure to plain language a non-technical client can act on. The raw
// text is still available in the error banner's "Technical details"
// disclosure and the Debug panel; this only decides the headline. Structured
// context (code, then validator layer, then stage) wins over the message text.
export function friendlyError(rawMessage: string | null | undefined, context: ErrorContext = {}): string {
  const message = String(rawMessage || '').trim();
  const code = typeof context.code === 'string' ? context.code.trim() : '';

  const byCode = code ? classifyByCode(code, message) : null;
  if (byCode) {
    return byCode;
  }
  const byStage = classifyByStage(context.stage, context.layer);
  if (byStage) {
    return byStage;
  }
  if (!message) {
    return MESSAGES.empty;
  }
  return classifyByMessage(message);
}

// Row count for the metric strip. When the server stopped at its row cap the
// exact total is unknown (totalRowCount null), so show "1,000+" rather than a
// number that would understate the result.
export function formatRowCount(result: { rowCount: number; totalRowCount: number | null; truncated: boolean }): string {
  if (typeof result.totalRowCount === 'number') {
    return result.totalRowCount.toLocaleString('en-US');
  }
  return result.truncated ? `${result.rowCount.toLocaleString('en-US')}+` : result.rowCount.toLocaleString('en-US');
}

const ERROR_STAGE_LABELS: Record<ErrorStage, string> = {
  llm: 'Model',
  validation: 'Blocked by guardrails',
  execution: 'Database error',
  aborted: 'Cancelled',
  infra: 'Service unavailable',
};

// Short label for the stage a failed question stopped in (null when unknown).
export function errorStageLabel(stage: ErrorStage | null | undefined): string | null {
  return stage ? ERROR_STAGE_LABELS[stage] ?? null : null;
}
