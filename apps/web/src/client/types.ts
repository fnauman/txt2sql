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

export interface QueryResponse {
  success: boolean;
  question: string;
  sql: string;
  rows: Record<string, unknown>[];
  columns: ResultColumn[];
  rowCount: number;
  totalRowCount: number;
  truncated: boolean;
  explanation: string;
  assumptions: string[];
  tablesUsed: string[];
  promptTables: string[];
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
  error: { name?: string; message: string; code?: string | null } | null;
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
  dbReachable?: boolean;
  error?: { message: string };
}
