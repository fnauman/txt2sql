import { parseFrame, type StreamAction } from './stream-protocol.ts';

interface QueryRequest {
  question: string;
  debug: boolean;
  includeInsights: boolean;
}

// Keep transport and request lifetime independent of React. Clear invalidates
// every callback and queued frame before aborting the request, so clearing a
// session cannot be undone by a late response or a lower-priority render.
export function createQueryStream(
  dispatch: (action: StreamAction) => void,
  { fetch: load = globalThis.fetch, transition = (work: () => void) => work() } = {}
) {
  let active: AbortController | null = null;
  let requestId = 0;

  async function run(request: QueryRequest): Promise<boolean> {
    active?.abort();
    const controller = new AbortController();
    active = controller;
    const id = ++requestId;
    const current = () => active === controller && !controller.signal.aborted;
    const emit = (action: StreamAction) => {
      if (current()) dispatch({ ...action, requestId: id });
    };
    emit({ event: '@start', data: { question: request.question } });

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const response = await load('/api/query/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!current()) {
        await response.body?.cancel();
        return false;
      }
      if (!response.ok || !response.body) {
        let error: { message: string; code?: string | null; stage?: string | null } = { message: 'Query request failed.' };
        try {
          const payload = await response.json();
          if (payload?.error?.message) {
            error = { message: payload.error.message, code: payload.error.code ?? null, stage: payload.error.stage ?? null };
          }
        } catch {
          /* non-JSON error body */
        }
        emit({ event: 'error', data: error });
        emit({ event: 'done' });
        return current();
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawTerminal = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (!current()) return false;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';
        for (const chunk of chunks) {
          const action = parseFrame(chunk);
          if (!action) continue;
          if (action.event === 'done' || action.event === 'error') sawTerminal = true;
          if (action.event === 'rows' || action.event === 'viz') {
            transition(() => emit(action));
          } else {
            emit(action);
          }
        }
      }
      if (!sawTerminal) {
        emit({ event: '@transport-error' });
        return false;
      }
      return current();
    } catch (error) {
      if (!current()) return false;
      emit({ event: '@transport-error', data: { message: reader ? 'The connection was interrupted before the answer finished.' : 'Could not reach the query service.' } });
      return false;
    } finally {
      if (reader) {
        try { await reader.cancel(); } catch { /* stream already closed */ }
        reader.releaseLock();
      }
    }
  }

  function cancel() {
    const controller = active;
    if (!controller) return;
    active = null;
    dispatch({ event: '@cancelled', requestId });
    controller.abort();
  }

  function clear() {
    const controller = active;
    active = null;
    dispatch({ event: '@reset', requestId: ++requestId });
    controller?.abort();
  }

  function dispose() {
    const controller = active;
    active = null;
    controller?.abort();
  }

  return { run, cancel, clear, dispose };
}
