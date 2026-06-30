import { loadSemanticLayerSync } from './semantic-layer.js';
import { uniqueStrings } from './utils.js';

export const PRODUCT_SEARCH_COLUMNS = [
  'ProductName',
  'ProductCode',
  'ProductTags',
];

export const PRODUCT_RESULT_COLUMNS = [
  'ProductId',
  'ProductCode',
  'ProductName',
  'ProductTags',
];

const DEFAULT_PRODUCT_QUERY_LIMIT = 200;
const DEFAULT_LIMIT_PER_TERM = 20;

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeLikeTerm(value) {
  return String(value || '').replace(/[\\%_]/g, (match) => `\\${match}`);
}

function likePattern(value) {
  const normalized = normalizeSearchText(value);
  // Normalization removes LIKE wildcards before parameter binding; escaping remains as defense in depth.
  return `%${escapeLikeTerm(normalized)}%`;
}

function rowSearchText(row) {
  return PRODUCT_SEARCH_COLUMNS.map((column) => row?.[column] || '').join(' ');
}

function normalizeCandidate(row) {
  return {
    ProductId: row.ProductId,
    ProductCode: row.ProductCode || null,
    ProductName: row.ProductName || null,
    ProductTags: row.ProductTags || null,
  };
}

export function extractProductSearchTerms(semanticPlan) {
  return uniqueStrings(
    (semanticPlan?.filterHints || [])
      .filter((hint) => hint.targetTable === 'Product')
      .flatMap((hint) => hint.matchedValues || [])
  );
}

export function expandProductSearchTerms(
  terms,
  { semanticLayer = loadSemanticLayerSync() } = {}
) {
  const productAliases = (semanticLayer.value_aliases || []).filter((entry) => entry.entity === 'product');

  return uniqueStrings(terms).map((term) => {
    const normalizedTerm = normalizeSearchText(term);
    const expanded = new Set([term]);

    for (const alias of productAliases) {
      const canonical = normalizeSearchText(alias.canonical_value);
      const aliases = (alias.aliases || []).map(normalizeSearchText);

      if (normalizedTerm === canonical || aliases.includes(normalizedTerm)) {
        expanded.add(alias.canonical_value);
        for (const value of alias.aliases || []) {
          expanded.add(value);
        }
      }
    }

    return {
      term,
      expandedTerms: uniqueStrings([...expanded]),
    };
  });
}

export function buildProductCandidateQuery(expandedTermGroup, { queryLimit = DEFAULT_PRODUCT_QUERY_LIMIT } = {}) {
  if (Array.isArray(expandedTermGroup) && expandedTermGroup.length > 1) {
    throw new Error('buildProductCandidateQuery accepts one term group; use buildProductCandidateQueries for multi-term prompts');
  }

  const group = Array.isArray(expandedTermGroup) ? expandedTermGroup[0] : expandedTermGroup;
  const expandedTerms = uniqueStrings(group?.expandedTerms || []);

  if (expandedTerms.length === 0) {
    return {
      term: group?.term || null,
      sql: '',
      params: [],
      resultColumns: PRODUCT_RESULT_COLUMNS,
      searchColumns: PRODUCT_SEARCH_COLUMNS,
      queryLimit,
    };
  }

  const searchClause = expandedTerms
    .map(() =>
      `(${PRODUCT_SEARCH_COLUMNS.map((column) => `LOWER(COALESCE(${column}, '')) LIKE ? ESCAPE '\\\\'`).join(' OR ')})`
    )
    .join(' OR ');
  const params = expandedTerms.flatMap((term) => PRODUCT_SEARCH_COLUMNS.map(() => likePattern(term)));

  return {
    term: group.term,
    sql: `SELECT ${PRODUCT_RESULT_COLUMNS.join(', ')} FROM Product WHERE ${searchClause} LIMIT ?`,
    params: [...params, queryLimit],
    resultColumns: PRODUCT_RESULT_COLUMNS,
    searchColumns: PRODUCT_SEARCH_COLUMNS,
    queryLimit,
  };
}

export function buildProductCandidateQueries(expandedTermGroups, { queryLimit = DEFAULT_PRODUCT_QUERY_LIMIT } = {}) {
  return (expandedTermGroups || [])
    .map((group) => buildProductCandidateQuery(group, { queryLimit }))
    .filter((query) => query.sql);
}

function scoreCandidateAgainstTerm(row, expandedTerms) {
  const fieldValues = PRODUCT_SEARCH_COLUMNS.map((column) => normalizeSearchText(row?.[column])).filter(Boolean);
  const combined = normalizeSearchText(rowSearchText(row));
  let best = {
    score: 0,
    matchedValue: null,
    matchType: null,
  };

  for (const term of expandedTerms || []) {
    const normalizedTerm = normalizeSearchText(term);
    if (!normalizedTerm) {
      continue;
    }

    let score = 0;
    let matchType = null;

    if (fieldValues.some((value) => value === normalizedTerm)) {
      score = 100;
      matchType = 'exact_field';
    } else if (fieldValues.some((value) => value.startsWith(`${normalizedTerm} `))) {
      score = 85;
      matchType = 'field_prefix';
    } else if (fieldValues.some((value) => value.includes(` ${normalizedTerm} `) || value.endsWith(` ${normalizedTerm}`))) {
      score = 75;
      matchType = 'word_phrase';
    } else if (combined.includes(normalizedTerm)) {
      score = 60;
      matchType = 'substring';
    } else {
      const termTokens = normalizedTerm.split(' ').filter(Boolean);
      if (termTokens.length > 0 && termTokens.every((token) => combined.includes(token))) {
        score = 45;
        matchType = 'token_overlap';
      }
    }

    if (score > best.score) {
      best = {
        score,
        matchedValue: term,
        matchType,
      };
    }
  }

  return best;
}

export function rankProductCandidates(rows, expandedTermGroups, { limitPerTerm = DEFAULT_LIMIT_PER_TERM } = {}) {
  return (expandedTermGroups || []).map((group) => {
    const candidates = (Array.isArray(rows) ? rows : [])
      .map((row) => ({
        ...normalizeCandidate(row),
        ...scoreCandidateAgainstTerm(row, group.expandedTerms),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          String(left.ProductName || '').localeCompare(String(right.ProductName || '')) ||
          Number(left.ProductId || 0) - Number(right.ProductId || 0)
      )
      .slice(0, limitPerTerm);

    return {
      term: group.term,
      expandedTerms: group.expandedTerms,
      candidates,
    };
  });
}

export async function resolveProductMasterDataCandidates(
  connection,
  semanticPlan,
  {
    semanticLayer = loadSemanticLayerSync(),
    queryLimit = DEFAULT_PRODUCT_QUERY_LIMIT,
    limitPerTerm = DEFAULT_LIMIT_PER_TERM,
  } = {}
) {
  const terms = extractProductSearchTerms(semanticPlan);
  const expandedTermGroups = expandProductSearchTerms(terms, { semanticLayer });
  const queries = buildProductCandidateQueries(expandedTermGroups, { queryLimit });

  if (!connection || queries.length === 0) {
    return {
      entity: 'product',
      searchColumns: PRODUCT_SEARCH_COLUMNS,
      queryLimit,
      limitPerTerm,
      terms: expandedTermGroups.map((group) => ({ ...group, candidates: [] })),
      totalCandidateCount: 0,
    };
  }

  const rowsByTerm = new Map();
  for (const query of queries) {
    const [rows] = await connection.query(query.sql, query.params);
    rowsByTerm.set(query.term, rows);
  }
  const termResults = expandedTermGroups.map(
    (group) => rankProductCandidates(rowsByTerm.get(group.term) || [], [group], { limitPerTerm })[0]
  );

  return {
    entity: 'product',
    searchColumns: PRODUCT_SEARCH_COLUMNS,
    queryLimit,
    limitPerTerm,
    terms: termResults,
    totalCandidateCount: termResults.reduce((count, group) => count + group.candidates.length, 0),
  };
}

export async function resolveMasterDataCandidates({
  connection,
  semanticPlan,
  semanticLayer = loadSemanticLayerSync(),
  queryLimit = DEFAULT_PRODUCT_QUERY_LIMIT,
  limitPerTerm = DEFAULT_LIMIT_PER_TERM,
} = {}) {
  const productCandidates = await resolveProductMasterDataCandidates(connection, semanticPlan, {
    semanticLayer,
    queryLimit,
    limitPerTerm,
  });

  return productCandidates.terms.length > 0 ? [productCandidates] : [];
}
