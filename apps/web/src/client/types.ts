export type ColumnType = 'text' | 'number' | 'date' | 'boolean';
export type ChartType = 'bar' | 'line' | 'area' | 'pie';

export interface ResultColumn {
  key: string;
  label: string;
  type: ColumnType;
  nonNullCount: number;
  numericCount: number;
  dateCount: number;
  uniqueCount: number;
  sampleValues: unknown[];
}

export interface VisualizationSuggestion {
  id: string;
  title: string;
  type: ChartType;
  xKey: string;
  yKeys: string[];
  reason: string;
  confidence: number;
}

export interface InsightCard {
  id: string;
  title: string;
  value: string;
  detail: string;
  tone: 'neutral' | 'positive' | 'warning';
}

export type BlockType = 'kpiStrip' | 'chart' | 'table' | 'narrative';

export interface LayoutBlock {
  id: string;
  type: BlockType;
  width?: 'full' | 'half';
  title?: string;
  body?: string;
  visualizationId?: string;
}

export interface LayoutSpec {
  version: number;
  confidence?: number;
  blocks: LayoutBlock[];
}

export interface DataResidency {
  engine: 'client-ok' | 'server-only';
  source: string;
}

export interface DebugEvent {
  timestamp: string;
  event: string;
  durationMs?: number;
  [key: string]: unknown;
}

// Where a failed question stopped (server contract; see src/query-service.js).
export type ErrorStage = 'llm' | 'validation' | 'execution' | 'aborted' | 'infra';

// Which SQL validator layer rejected a query (src/sql-guardrails.js
// SqlValidationError.layer): 'safety' is the read-only/table-scope check,
// 'guardrail' the schema-aware check against the prompt context.
export type ValidationLayer = 'safety' | 'guardrail';

export interface QueryError {
  name?: string;
  message: string;
  code?: string | null;
  stage?: ErrorStage | null;
  layer?: ValidationLayer | null;
}

export interface QueryResponse {
  success: boolean;
  question: string;
  sql: string;
  rows: Record<string, unknown>[];
  columns: ResultColumn[];
  rowCount: number;
  // null when the result was truncated at the server-side row cap: there are
  // more than rowCount rows, but the exact total is unknown.
  totalRowCount: number | null;
  truncated: boolean;
  explanation: string;
  assumptions: string[];
  tablesUsed: string[];
  // The validator's allow-list (every in-scope table in the full schema scope).
  promptTables: string[];
  // Retrieval's ranking for the question; empty when nothing matched.
  rankedTables?: string[];
  visualizations: VisualizationSuggestion[];
  insights: InsightCard[];
  layout?: LayoutSpec | null;
  dataResidency?: DataResidency | null;
  llmUsage: Record<string, unknown> | null;
  llmCost: {
    currency?: string;
    totalCost?: number;
    totalTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
  } | null;
  attemptCount: number;
  errorStage?: ErrorStage | null;
  errorCode?: string | null;
  error: QueryError | null;
  debug: {
    events: DebugEvent[];
    llmCalls: unknown[];
    masterDataCandidates: unknown[];
    rawResponse: string | null;
  } | null;
}

export interface DashboardPin {
  id: string;
  type: 'table' | 'chart' | 'insight';
  title: string;
  question: string;
  createdAt: string;
  result: QueryResponse;
  visualizationId?: string;
  insightId?: string;
}

export interface HealthResponse {
  ok: boolean;
  runtimeReady: boolean;
  openAiConfigured: boolean;
  dbConfigured: boolean;
  model: string;
  authRequired?: boolean;
  // Whether the server honors the Debug toggle (WEB_ALLOW_DEBUG).
  debugAllowed?: boolean;
  cacheEnabled?: boolean;
  dataResidency?: DataResidency['engine'];
  // null when the deep check failed before reaching the database.
  dbReachable?: boolean | null;
  error?: { message: string; code?: string | null };
}
