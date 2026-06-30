// Deterministic, zero-LLM layout planner. Promotes the already-computed
// visualizations[] + insights[] (from result-intelligence.js) into an ordered
// LayoutSpec of typed blocks. This is the "adaptive UI from data shape" decision,
// made for free on the hot path. An optional LLM layout_hint can later refine
// this spec, but it must never be on the first-paint critical path.
//
// Block contract (rendered by a TRUSTED client registry — never eval'd):
//   { id, type: 'kpiStrip'|'chart'|'table'|'narrative', width: 'full'|'half', ... }
//
// The same contract generalizes beyond SQL: a csv/xlsx agent emits the same
// blocks; a markdown/pdf agent just adds 'narrative' (and future excerpt/citation)
// block types to the registry.

export function buildLayoutSpec(result) {
  const blocks = [];

  const insights = Array.isArray(result?.insights) ? result.insights : [];
  const visualizations = Array.isArray(result?.visualizations) ? result.visualizations : [];
  const columns = Array.isArray(result?.columns) ? result.columns : [];
  const hasChart = visualizations.length > 0;
  const hasTable = columns.length > 0;

  if (insights.length > 0) {
    blocks.push({ id: 'kpis', type: 'kpiStrip', width: 'full' });
  }

  // Chart and table share a row when both are present (reproduces the current
  // side-by-side layout); whichever is alone spans full width.
  if (hasChart) {
    blocks.push({ id: 'chart', type: 'chart', width: hasTable ? 'half' : 'full' });
  }
  if (hasTable) {
    blocks.push({ id: 'table', type: 'table', width: hasChart ? 'half' : 'full' });
  }

  const confidence = hasChart
    ? Math.max(...visualizations.map((visualization) => Number(visualization.confidence) || 0))
    : 0.5;

  return { version: 1, confidence, blocks };
}
