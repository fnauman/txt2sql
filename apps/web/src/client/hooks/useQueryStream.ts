import { startTransition, useEffect, useMemo, useReducer } from 'react';

import { createQueryStream } from '../lib/query-stream';
import { initialStreamState, streamReducer } from '../lib/stream-protocol';

export type { PipelineStage, StageStatus, StreamState } from '../lib/stream-protocol';
export { STAGE_LABELS, STAGE_ORDER } from '../lib/stream-protocol';

export function useQueryStream() {
  const [state, dispatch] = useReducer(streamReducer, initialStreamState());
  const stream = useMemo(() => createQueryStream(dispatch, { transition: startTransition }), []);
  useEffect(() => () => stream.dispose(), [stream]);
  return { state, run: stream.run, cancel: stream.cancel, clear: stream.clear };
}
