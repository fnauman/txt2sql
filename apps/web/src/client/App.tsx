import { FormEvent, useState } from 'react';
import { BarChart3, LayoutDashboard, Loader2, Moon, RefreshCcw, Search, Sun, TableProperties, X } from 'lucide-react';

import { useHealth } from './hooks/useHealth';
import { usePins } from './hooks/usePins';
import { useQueryStream } from './hooks/useQueryStream';
import { useRecentQueries } from './hooks/useRecentQueries';
import { useTheme } from './hooks/useTheme';
import { EXAMPLES } from './lib/constants';
import { compactResultForPin, createId } from './lib/pin-utils';
import type { DashboardPin, InsightCard, VisualizationSuggestion } from './types';

import { StatusBar } from './features/ask/StatusBar';
import { ResultRegion } from './features/ask/ResultRegion';
import { DashboardView } from './features/dashboard/DashboardView';

type ViewMode = 'ask' | 'dashboard';

export default function App() {
  const [view, setView] = useState<ViewMode>('ask');
  const [question, setQuestion] = useState('');
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [includeInsights, setIncludeInsights] = useState(true);
  const health = useHealth();
  const { theme, toggle: toggleTheme } = useTheme();
  const { recentQueries, pushRecent } = useRecentQueries();
  const { pins, addPin, removePin } = usePins();
  const { state, run, cancel } = useQueryStream();
  const result = state.result;
  const loading = state.status === 'streaming';

  const executeQuery = async (nextQuestion = question) => {
    const trimmed = nextQuestion.trim();
    if (!trimmed || loading) {
      return;
    }

    setQuestion(trimmed);
    try {
      const completed = await run({ question: trimmed, debug: debugEnabled, includeInsights });
      if (completed) {
        pushRecent(trimmed);
      }
    } catch {
      // Aborted via the Stop button — keep whatever streamed in so far.
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void executeQuery();
  };

  const pinProduct = (type: DashboardPin['type'], options: { visualization?: VisualizationSuggestion; insight?: InsightCard } = {}) => {
    if (!state.hasColumns) {
      return;
    }

    const title = options.visualization?.title || options.insight?.title || `${result.rowCount.toLocaleString()} row table`;
    const pin: DashboardPin = {
      id: createId(),
      type,
      title,
      question: result.question,
      createdAt: new Date().toISOString(),
      result: compactResultForPin(result, type, options),
      visualizationId: options.visualization?.id,
      insightId: options.insight?.id,
    };
    addPin(pin);
  };

  const runFollowUp = (insight: InsightCard) => {
    const dimension = insight.value.replace(/^break down by\s*/i, '').trim();
    const base = state.result.question || question;
    void executeQuery(dimension ? `${base} broken down by ${dimension}` : base);
  };

  return (
    <div className="app-shell">
      <nav className="side-nav" aria-label="Primary">
        <div className="brand-mark">SQL</div>
        <button className={view === 'ask' ? 'active' : ''} type="button" onClick={() => setView('ask')} title="Ask" aria-label="Ask">
          <Search size={21} />
        </button>
        <button className={view === 'dashboard' ? 'active' : ''} type="button" onClick={() => setView('dashboard')} title="Dashboard" aria-label="Dashboard">
          <LayoutDashboard size={21} />
        </button>
        <button
          className="theme-toggle"
          type="button"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
        </button>
      </nav>

      {view === 'dashboard' ? (
        <DashboardView pins={pins} onRemove={removePin} />
      ) : (
        <main className="ask-view">
          <section className="query-band">
            <div className="query-copy">
              <p className="eyebrow">demo query console</p>
              <h1>Ask the database directly.</h1>
              <StatusBar health={health} />
            </div>
            <form className="query-composer" onSubmit={submit}>
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="Show outstanding balance by customer"
                rows={4}
              />
              <div className="composer-actions">
                <div className="toggles">
                  <label>
                    <input type="checkbox" checked={debugEnabled} onChange={(event) => setDebugEnabled(event.target.checked)} />
                    <span>Debug</span>
                  </label>
                  <label>
                    <input type="checkbox" checked={includeInsights} onChange={(event) => setIncludeInsights(event.target.checked)} />
                    <span>Insights</span>
                  </label>
                </div>
                <div className="run-actions">
                  {!question.trim() && !loading && <span className="composer-hint">Enter a question to run.</span>}
                  {loading && (
                    <button className="secondary-button" type="button" onClick={cancel}>
                      <X size={17} />
                      Stop
                    </button>
                  )}
                  <button className="primary-button" type="submit" disabled={loading || !question.trim()}>
                    {loading ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
                    Run
                  </button>
                </div>
              </div>
            </form>
          </section>

          <section className="prompt-strip" aria-label="Query shortcuts">
            {EXAMPLES.map((example) => (
              <button key={example} type="button" onClick={() => void executeQuery(example)} disabled={loading}>
                {example}
              </button>
            ))}
          </section>

          {recentQueries.length > 0 && (
            <section className="recent-strip" aria-label="Recent queries">
              <RefreshCcw size={16} />
              {recentQueries.map((product) => (
                <button key={product} type="button" onClick={() => void executeQuery(product)} disabled={loading}>
                  {product}
                </button>
              ))}
            </section>
          )}

          {state.status === 'idle' ? (
            <div className="blank-slate">
              <TableProperties size={28} />
              <span>Results will appear here</span>
              <BarChart3 size={28} />
            </div>
          ) : (
            <ResultRegion state={state} debugEnabled={debugEnabled} onPin={pinProduct} onFollowUp={runFollowUp} />
          )}
        </main>
      )}
    </div>
  );
}
