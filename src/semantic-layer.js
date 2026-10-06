import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { uniqueStrings } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_SEMANTIC_LAYER_PATH = path.resolve(__dirname, '../metadata/semantic-layer.json');
// Hints version 2's overlay (src/hints-version.js): applied on top of the base
// layer when HINTS_VERSION=2; version 1 reads the base layer alone.
export const HINTS_V2_SEMANTIC_LAYER_OVERLAY_PATH = path.resolve(__dirname, '../metadata/semantic-layer.hints-v2.json');

const cachedLayers = new Map();

function normalizeEntry(entry) {
  return {
    ...entry,
    name: String(entry?.name || '').trim(),
    synonyms: uniqueStrings(entry?.synonyms),
    preferred_tables: uniqueStrings(entry?.preferred_tables),
    display_columns: uniqueStrings(entry?.display_columns),
    default_filters: uniqueStrings(entry?.default_filters),
    preferred_columns: uniqueStrings(entry?.preferred_columns),
    notes: uniqueStrings(entry?.notes),
  };
}

function normalizeJoinPath(joinPath) {
  return {
    ...joinPath,
    name: String(joinPath?.name || '').trim(),
    tables: uniqueStrings(joinPath?.tables),
    join_sql: String(joinPath?.join_sql || '').trim(),
  };
}

function normalizeFilterHint(filterHint) {
  return {
    ...filterHint,
    name: String(filterHint?.name || '').trim(),
    synonyms: uniqueStrings(filterHint?.synonyms),
    target_table: String(filterHint?.target_table || '').trim(),
    target_columns: uniqueStrings(filterHint?.target_columns),
    operator: String(filterHint?.operator || '').trim(),
    notes: uniqueStrings(filterHint?.notes),
  };
}

function normalizeValueAlias(valueAlias) {
  return {
    ...valueAlias,
    entity: String(valueAlias?.entity || '').trim(),
    canonical_value: String(valueAlias?.canonical_value || '').trim(),
    aliases: uniqueStrings(valueAlias?.aliases),
    target_columns: uniqueStrings(valueAlias?.target_columns),
  };
}

export function normalizeSemanticLayer(raw = {}) {
  return {
    version: raw?.version ?? null,
    entities: (Array.isArray(raw?.entities) ? raw.entities : []).map(normalizeEntry).filter((entry) => entry.name),
    metrics: (Array.isArray(raw?.metrics) ? raw.metrics : []).map(normalizeEntry).filter((entry) => entry.name),
    filter_hints: (Array.isArray(raw?.filter_hints) ? raw.filter_hints : [])
      .map(normalizeFilterHint)
      .filter((entry) => entry.name),
    value_aliases: (Array.isArray(raw?.value_aliases) ? raw.value_aliases : [])
      .map(normalizeValueAlias)
      .filter((entry) => entry.entity && entry.canonical_value),
    join_paths: (Array.isArray(raw?.join_paths) ? raw.join_paths : [])
      .map(normalizeJoinPath)
      .filter((entry) => entry.name && entry.tables.length > 0 && entry.join_sql),
    clarification_rules: Array.isArray(raw?.clarification_rules) ? raw.clarification_rules : [],
  };
}

export function loadSemanticLayerSync({ filePath = DEFAULT_SEMANTIC_LAYER_PATH, optional = true } = {}) {
  const resolvedPath = path.resolve(filePath);
  if (cachedLayers.has(resolvedPath)) {
    return cachedLayers.get(resolvedPath);
  }

  try {
    const layer = normalizeSemanticLayer(JSON.parse(fs.readFileSync(resolvedPath, 'utf8')));
    cachedLayers.set(resolvedPath, layer);
    return layer;
  } catch (error) {
    if (optional && error.code === 'ENOENT') {
      const layer = normalizeSemanticLayer();
      cachedLayers.set(resolvedPath, layer);
      return layer;
    }
    throw error;
  }
}

// The named kinds an overlay may change; anything else in an overlay is an
// error, so a misspelled key never silently changes nothing.
const OVERLAY_KINDS = ['entities', 'metrics', 'filter_hints', 'join_paths'];
const OVERLAY_META_KEYS = ['version', 'description'];

/**
 * A raw semantic layer with `overlay` applied: per kind (entities, metrics,
 * filter_hints, join_paths) an overlay entry replaces the base entry of the
 * same name in full, in place; an entry with a new name is appended. The
 * overlay's `version` becomes the layer's. Other base kinds are kept as they
 * are. Throws on an unknown overlay key or an entry without a name.
 */
export function applySemanticLayerOverlay(base = {}, overlay = {}) {
  const unknown = Object.keys(overlay).filter((key) => !OVERLAY_KINDS.includes(key) && !OVERLAY_META_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(`Semantic layer overlay has unknown keys: ${unknown.join(', ')} (allowed: ${[...OVERLAY_KINDS, ...OVERLAY_META_KEYS].join(', ')}).`);
  }
  const merged = { ...base, version: overlay.version ?? base.version ?? null };
  for (const kind of OVERLAY_KINDS) {
    if (overlay[kind] === undefined) {
      continue;
    }
    if (!Array.isArray(overlay[kind])) {
      throw new Error(`Semantic layer overlay "${kind}" must be an array.`);
    }
    const entries = Array.isArray(base[kind]) ? [...base[kind]] : [];
    for (const entry of overlay[kind]) {
      const name = String(entry?.name || '').trim();
      if (!name) {
        throw new Error(`Semantic layer overlay "${kind}" has an entry without a name.`);
      }
      const index = entries.findIndex((existing) => String(existing?.name || '').trim() === name);
      if (index >= 0) {
        entries[index] = entry;
      } else {
        entries.push(entry);
      }
    }
    merged[kind] = entries;
  }
  return merged;
}

function readJsonSync(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * The semantic layer hints version `version` (src/hints-version.js) reads:
 * version 1 the base layer (exactly loadSemanticLayerSync), version 2 the base
 * layer with the hints-v2 overlay applied. Cached per file pair.
 */
export function loadSemanticLayerForHintsVersion(
  version = 1,
  { filePath = DEFAULT_SEMANTIC_LAYER_PATH, overlayPath = HINTS_V2_SEMANTIC_LAYER_OVERLAY_PATH } = {}
) {
  if (Number(version) === 1) {
    return loadSemanticLayerSync({ filePath });
  }
  const key = `${path.resolve(filePath)}\u0000${path.resolve(overlayPath)}`;
  if (cachedLayers.has(key)) {
    return cachedLayers.get(key);
  }
  const layer = normalizeSemanticLayer(applySemanticLayerOverlay(readJsonSync(path.resolve(filePath)), readJsonSync(path.resolve(overlayPath))));
  cachedLayers.set(key, layer);
  return layer;
}

export function clearSemanticLayerCache(filePath = null) {
  if (filePath) {
    const resolved = path.resolve(filePath);
    for (const key of [...cachedLayers.keys()]) {
      if (key === resolved || key.split('\u0000').includes(resolved)) {
        cachedLayers.delete(key);
      }
    }
    return;
  }

  cachedLayers.clear();
}

export function reloadSemanticLayerSync({ filePath = DEFAULT_SEMANTIC_LAYER_PATH, optional = true } = {}) {
  clearSemanticLayerCache(filePath);
  return loadSemanticLayerSync({ filePath, optional });
}
