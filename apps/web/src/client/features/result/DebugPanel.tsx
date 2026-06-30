import { Bug } from 'lucide-react';

import type { QueryResponse } from '../../types';
import { CopyButton } from './CopyButton';

export function DebugPanel({ result }: { result: QueryResponse }) {
  const events = result.debug?.events || [];
  const llmCalls = result.debug?.llmCalls || [];
  const masterData = result.debug?.masterDataCandidates || [];
  const rawResponse = result.debug?.rawResponse || '';
  return (
    <aside className="debug-panel" aria-label="Debug and execution trace">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Debug</p>
          <h2>Execution trace</h2>
        </div>
        <Bug size={20} />
      </div>
      <div className="debug-section">
        <div className="debug-section-head">
          <h3>SQL</h3>
          {result.sql && <CopyButton value={result.sql} label="Copy SQL" />}
        </div>
        <pre>{result.sql || 'No SQL generated'}</pre>
      </div>
      <div className="debug-section">
        <h3>Explanation</h3>
        <p>{result.explanation || '-'}</p>
      </div>
      <div className="debug-section two-col">
        <div>
          <h3>Retrieved</h3>
          <ul>{result.promptTables.map((table) => <li key={table}>{table}</li>)}</ul>
        </div>
        <div>
          <h3>Used</h3>
          <ul>{result.tablesUsed.map((table) => <li key={table}>{table}</li>)}</ul>
        </div>
      </div>
      <div className="debug-section">
        <h3>Assumptions</h3>
        <ul>{(result.assumptions.length ? result.assumptions : ['-']).map((product) => <li key={product}>{product}</li>)}</ul>
      </div>
      {masterData.length > 0 && (
        <div className="debug-section">
          <h3>Master-data candidates</h3>
          <details>
            <summary>{masterData.length} resolved group(s)</summary>
            <pre>{JSON.stringify(masterData, null, 2)}</pre>
          </details>
        </div>
      )}
      {llmCalls.length > 0 && (
        <div className="debug-section">
          <h3>LLM calls ({llmCalls.length})</h3>
          <div className="event-list">
            {llmCalls.map((call, index) => (
              <details key={index}>
                <summary>
                  <span>attempt {index + 1}</span>
                </summary>
                <pre>{JSON.stringify(call, null, 2)}</pre>
              </details>
            ))}
          </div>
        </div>
      )}
      {rawResponse && (
        <div className="debug-section">
          <div className="debug-section-head">
            <h3>Raw model response</h3>
            <CopyButton value={rawResponse} label="Copy raw response" />
          </div>
          <details>
            <summary>Show raw JSON</summary>
            <pre>{rawResponse}</pre>
          </details>
        </div>
      )}
      <div className="debug-section">
        <h3>Events</h3>
        <div className="event-list">
          {events.map((event, index) => (
            <details key={`${event.event}-${index}`}>
              <summary>
                <span>{event.event}</span>
                <em>{typeof event.durationMs === 'number' ? `${event.durationMs.toFixed(1)} ms` : ''}</em>
              </summary>
              <pre>{JSON.stringify(event, null, 2)}</pre>
            </details>
          ))}
          {events.length === 0 && <p>Enable the Debug toggle before running a query to capture the execution trace.</p>}
        </div>
      </div>
    </aside>
  );
}
