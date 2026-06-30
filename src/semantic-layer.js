import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { uniqueStrings } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_SEMANTIC_LAYER_PATH = path.resolve(__dirname, '../metadata/semantic-layer.json');

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

export function clearSemanticLayerCache(filePath = null) {
  if (filePath) {
    cachedLayers.delete(path.resolve(filePath));
    return;
  }

  cachedLayers.clear();
}

export function reloadSemanticLayerSync({ filePath = DEFAULT_SEMANTIC_LAYER_PATH, optional = true } = {}) {
  clearSemanticLayerCache(filePath);
  return loadSemanticLayerSync({ filePath, optional });
}
