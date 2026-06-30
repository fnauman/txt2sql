import { startTransition, useCallback, useReducer, useRef } from 'react';

import { initialStreamState, parseFrame, streamReducer } from '../lib/stream-protocol';

export type { PipelineStage, StageStatus, StreamState } from '../lib/stream-protocol';
export { STAGE_LABELS, STAGE_ORDER } from '../lib/stream-protocol';

export function useQueryStream() {
  const [state, dispatch] = useReducer(streamReducer, initialStreamState());
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (request: { question: string; debug: boolean; includeInsights: boolean }): Promise<boolean> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      dispatch({ event: '@start', data: { question: request.question } });

      let response: Response;
      try {
        response = await fetch('/api/query/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          dispatch({ event: '@cancelled' });
          throw error;
        }
        dispatch({ event: '@transport-error', data: { message: 'Could not reach the query service.' } });
        return false;
      }

      if (!response.ok || !response.body) {
        let message = 'Query request failed.';
        try {
          const payload = await response.json();
          message = payload?.error?.message || message;
        } catch {
          /* non-JSON error body */
        }
        dispatch({ event: 'error', data: { message } });
        dispatch({ event: 'done' });
        return true;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawTerminal = false;

      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() ?? '';
          for (const chunk of chunks) {
            const action = parseFrame(chunk);
            if (!action) {
              continue;
            }
            if (action.event === 'done' || action.event === 'error') {
              sawTerminal = true;
            }
            // Keep heavy frames off the urgent path so the stepper + SQL card stay snappy.
            if (action.event === 'rows' || action.event === 'viz') {
              startTransition(() => dispatch(action));
            } else {
              dispatch(action);
            }
          }
        }
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          dispatch({ event: '@cancelled' });
          throw error;
        }
        dispatch({ event: '@transport-error' });
        return false;
      }

      if (!sawTerminal) {
        dispatch({ event: '@transport-error' });
        return false;
      }
      return true;
    },
    []
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  return { state, run, cancel };
}
