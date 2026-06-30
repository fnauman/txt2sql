// Pure SSE-protocol logic for the streaming query path — no React, no fetch — so
// it can be unit-tested in isolation. The hook (hooks/useQueryStream.ts) wires
// this to fetch + useReducer.

import type { QueryResponse } from '../types';

export type PipelineStage =
  | 'planning'
  | 'resolving_entities'
  | 'generating_sql'
  | 'validating'
  | 'executing'
  | 'shaping';

export type StageStatus = 'idle' | 'active' | 'done';

export const STAGE_ORDER: PipelineStage[] = [
  'planning',
  'resolving_entities',
  'generating_sql',
  'validating',
  'executing',
  'shaping',
];

export const STAGE_LABELS: Record<PipelineStage, string> = {
  planning: 'Planning',
  resolving_entities: 'Resolving entities',
  generating_sql: 'Generating SQL',
  validating: 'Validating',
  executing: 'Executing',
  shaping: 'Shaping results',
};

export interface StreamState {
  status: 'idle' | 'streaming' | 'done' | 'error';
  stages: Record<PipelineStage, StageStatus>;
  result: QueryResponse;
  hasSql: boolean;
  hasColumns: boolean;
  hasRows: boolean;
  hasViz: boolean;
  hasInsights: boolean;
  cacheHit: boolean;
  error: string | null;
}

export type StreamAction = { event: string; data?: any };

function idleStages(): Record<PipelineStage, StageStatus> {
  return STAGE_ORDER.reduce((acc, stage) => {
    acc[stage] = 'idle';
    return acc;
  }, {} as Record<PipelineStage, StageStatus>);
}

function emptyResult(question = ''): QueryResponse {
  return {
    success: false,
    question,
    sql: '',
    rows: [],
    columns: [],
    rowCount: 0,
    totalRowCount: 0,
    truncated: false,
    explanation: '',
    assumptions: [],
    tablesUsed: [],
    promptTables: [],
    visualizations: [],
    insights: [],
    layout: null,
    dataResidency: null,
    llmUsage: null,
    llmCost: null,
    attemptCount: 0,
    error: null,
    debug: null,
  };
}

export function initialStreamState(question = ''): StreamState {
  return {
    status: 'idle',
    stages: idleStages(),
    result: emptyResult(question),
    hasSql: false,
    hasColumns: false,
    hasRows: false,
    hasViz: false,
    hasInsights: false,
    cacheHit: false,
    error: null,
  };
}

export function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.event) {
    case '@start': {
      const next = initialStreamState(action.data?.question || '');
      next.status = 'streaming';
      next.stages.planning = 'active';
      return next;
    }
    case 'stage': {
      const arrived = action.data.stage as PipelineStage;
      const idx = STAGE_ORDER.indexOf(arrived);
      if (idx < 0) {
        return state;
      }
      const stages = { ...state.stages };
      STAGE_ORDER.forEach((stage, i) => {
        if (i < idx && stages[stage] !== 'done') {
          stages[stage] = 'done';
        }
      });
      if (stages[arrived] !== 'done') {
        stages[arrived] = 'active';
      }
      return { ...state, stages };
    }
    case 'sql':
      return {
        ...state,
        hasSql: true,
        cacheHit: action.data.cacheHit ?? state.cacheHit,
        result: {
          ...state.result,
          sql: action.data.sql ?? state.result.sql,
          explanation: action.data.explanation ?? state.result.explanation,
          tablesUsed: action.data.tablesUsed ?? state.result.tablesUsed,
          assumptions: action.data.assumptions ?? state.result.assumptions,
          promptTables: action.data.promptTables ?? state.result.promptTables,
        },
      };
    case 'columns':
      return {
        ...state,
        hasColumns: true,
        result: {
          ...state.result,
          columns: action.data.columns ?? [],
          totalRowCount: action.data.totalRowCount ?? 0,
          truncated: Boolean(action.data.truncated),
        },
      };
    case 'rows': {
      const rows = action.data.rows ?? [];
      return { ...state, hasRows: true, result: { ...state.result, rows, rowCount: rows.length } };
    }
    case 'viz':
      return { ...state, hasViz: true, result: { ...state.result, visualizations: action.data.visualizations ?? [] } };
    case 'insights':
      return { ...state, hasInsights: true, result: { ...state.result, insights: action.data.insights ?? [] } };
    case 'layout':
      return { ...state, result: { ...state.result, layout: action.data.layout ?? null } };
    case 'residency':
      return { ...state, result: { ...state.result, dataResidency: action.data.dataResidency ?? null } };
    case 'metrics':
      return {
        ...state,
        cacheHit: Boolean(action.data.cacheHit),
        result: {
          ...state.result,
          success: true,
          attemptCount: action.data.attemptCount ?? state.result.attemptCount,
          llmCost: action.data.llmCost ?? null,
          llmUsage: action.data.llmUsage ?? null,
        },
      };
    case 'debug':
      return { ...state, result: { ...state.result, debug: action.data } };
    case 'error': {
      const message = action.data?.message ?? 'The query could not be answered.';
      return {
        ...state,
        status: 'error',
        error: message,
        result: { ...state.result, success: false, error: action.data ?? { message } },
      };
    }
    case 'done': {
      const stages = { ...state.stages };
      STAGE_ORDER.forEach((stage) => {
        stages[stage] = 'done';
      });
      const ok = state.status !== 'error';
      return { ...state, stages, status: ok ? 'done' : 'error', result: { ...state.result, success: ok } };
    }
    case '@cancelled':
      return { ...state, status: state.hasColumns ? 'done' : 'idle' };
    case '@transport-error': {
      const message = action.data?.message ?? 'The connection was interrupted before the answer finished.';
      return { ...state, status: 'error', error: message, result: { ...state.result, success: false, error: { message } } };
    }
    default:
      return state;
  }
}

// Parse one SSE frame ("event: <name>\ndata: <json>"). Returns null for comment
// / keepalive lines (no event field).
export function parseFrame(chunk: string): StreamAction | null {
  const eventLine = chunk.match(/^event: (.*)$/m)?.[1];
  if (!eventLine) {
    return null;
  }
  const dataLine = chunk.match(/^data: (.*)$/m)?.[1];
  let data: any = null;
  if (dataLine) {
    try {
      data = JSON.parse(dataLine);
    } catch {
      data = null;
    }
  }
  return { event: eventLine, data };
}
