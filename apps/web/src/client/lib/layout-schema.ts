import { z } from 'zod';

import type { LayoutSpec, QueryResponse } from '../types';

// Structural validation of any LayoutSpec — whether deterministic (server) or,
// in future, an LLM layout_hint. Nothing is rendered until it passes this AND
// the column cross-check below. The trusted registry (blocks/registry.tsx) then
// renders blocks by NAME only — never eval / dangerouslySetInnerHTML.

export const blockSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['kpiStrip', 'chart', 'table', 'narrative']),
  width: z.enum(['full', 'half']).optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  visualizationId: z.string().optional(),
});

export const layoutSpecSchema = z.object({
  version: z.number(),
  confidence: z.number().optional(),
  blocks: z.array(blockSchema).max(24),
});

// Returns a safe-to-render spec, or null if the input is missing/invalid. Beyond
// structure, it cross-checks block references against the ACTUAL result so a
// (possibly model-authored) spec can never point a chart at a non-existent
// visualization. Prop values themselves remain untrusted — React escaping only.
export function validateLayout(raw: unknown, result: QueryResponse): LayoutSpec | null {
  const parsed = layoutSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }

  const vizIds = new Set((result.visualizations ?? []).map((visualization) => visualization.id));
  const blocks = parsed.data.blocks.filter((block) => {
    if (block.type === 'chart' && block.visualizationId && !vizIds.has(block.visualizationId)) {
      return false; // chart points at a visualization that isn't in this result
    }
    return true;
  });

  if (blocks.length === 0) {
    return null;
  }

  return { ...parsed.data, blocks };
}
