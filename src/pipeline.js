import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI, { APIUserAbortError } from 'openai';
import mysql from 'mysql2/promise';

import {
  businessRulesFor,
  DEFAULT_INCLUDED_TABLES,
  FEW_SHOT_EXAMPLES,
  NO_SQL_COMMENTS_RULE,
  TABLE_ALIASES,
} from './constants.js';
import { calculateCost } from './pricing.js';
import { ensureCompiledSchema, filterSchema } from './schema-compiler.js';
import { normalizeHintsVersion } from './hints-version.js';
import { normalizeSchemaScopeConfig } from './schema-scope.js';
import { loadSemanticLayerForHintsVersion } from './semantic-layer.js';
import { SqlValidationError, validateSqlGuardrails } from './sql-guardrails.js';
import {
  SqlTokenizeError,
  analyzeSqlStructure,
  isKeywordToken,
  stripSqlTokens,
  tokenizeSql,
} from './sql-tokenizer.js';
import { uniqueStrings } from './utils.js';

function splitWords(value) {
  return String(value || '')
    .replace(/\b([A-Z]{2,})s\b/g, (match) => match.toLowerCase())
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'then',
  'else',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'do',
  'does',
  'did',
  'have',
  'has',
  'had',
  'how',
  'what',
  'which',
  'who',
  'whom',
  'when',
  'where',
  'why',
  'show',
  'list',
  'give',
  'get',
  'tell',
  'me',
  'we',
  'us',
  'our',
  'your',
  'their',
  'them',
  'this',
  'that',
  'these',
  'those',
  'by',
  'for',
  'to',
  'from',
  'in',
  'on',
  'at',
  'of',
  'with',
  'without',
]);

// Hints version 2: words retrieval ignores. Each one matched a column name or
// comment only by accident and pointed the relevance hint (and the retrieved
// scope's column order) at the wrong column: "included" and "distinct" at
// NetPayableAmount ("Net payable amount; included as an intentionally
// distinct metric", tpl_total_net_sales_feb15_mar15_2026_40ae9d), "total" at
// BillTotalAmount and line TotalAmount (edge_public_002), "units" at
// SalePrice ("Unit sale price"), "recorded" at AccountingPosting.PostingDate,
// "used", "column" and "row" at the decoy DocumentTypeClass and posting
// comments, "as" at several comments. The semantic plan does not read these
// tokens: "units" still matches quantity_sold.
const RETRIEVAL_STOPWORDS_V2 = new Set([
  'as',
  'include',
  'included',
  'including',
  'inclusive',
  'distinct',
  'total',
  'totals',
  'unit',
  'units',
  'record',
  'records',
  'recorded',
  'used',
  'column',
  'columns',
  'row',
  'rows',
]);

function singularTokenVariant(token) {
  if (token.length <= 3) {
    return token;
  }

  if (token.endsWith('ies') && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }

  if (
    token.endsWith('ches') ||
    token.endsWith('shes') ||
    token.endsWith('sses') ||
    token.endsWith('xes') ||
    token.endsWith('zes')
  ) {
    return token.slice(0, -2);
  }

  if (token.endsWith('s') && !token.endsWith('ss') && token.length > 3) {
    return token.slice(0, -1);
  }

  return token;
}

// Expand a token into a small set of morphological variants so lexical matching
// generalizes across inflections (plurals, -ing/-ed/-er) without a heavyweight
// stemmer or embeddings. Both "ate -> e" restorations are included because
// suffix stripping alone turns "moved" into "mov" rather than "move".
export function tokenVariants(token) {
  const variants = new Set();
  // The original token and its singular form are kept even when short (real
  // words like "buy" or "tax"). Suffix-stripped stems, however, must be at
  // least 4 chars: stripping "-ing"/"-ed" from short words yields spurious
  // fragments (e.g. "bring" -> "bre") that could match unrelated tokens.
  const addExact = (value) => {
    if (value && value.length >= 3) {
      variants.add(value);
    }
  };
  const addStem = (value) => {
    if (value && value.length >= 4) {
      variants.add(value);
    }
  };

  addExact(token);
  addExact(singularTokenVariant(token));

  for (const base of [...variants]) {
    if (base.length > 4 && base.endsWith('ing')) {
      addStem(base.slice(0, -3));
      addStem(`${base.slice(0, -3)}e`);
    }
    if (base.length > 4 && base.endsWith('ed')) {
      addStem(base.slice(0, -2));
      addStem(base.slice(0, -1));
    }
    if (base.length > 4 && base.endsWith('ers')) {
      addStem(base.slice(0, -3));
      addStem(base.slice(0, -2));
    } else if (base.length > 4 && base.endsWith('er')) {
      addStem(base.slice(0, -2));
      addStem(base.slice(0, -1));
    }
  }

  return variants;
}

export function normalizeTokens(text) {
  const tokens = [];

  for (const token of splitWords(text)) {
    if (token.length <= 1 || STOPWORDS.has(token)) {
      continue;
    }

    tokens.push(token);
    const singular = singularTokenVariant(token);
    if (singular !== token && singular.length > 1 && !STOPWORDS.has(singular)) {
      tokens.push(singular);
    }
  }

  return [...new Set(tokens)];
}

const MONTHS = [
  ['january', 1, ['jan']],
  ['february', 2, ['feb']],
  ['march', 3, ['mar']],
  ['april', 4, ['apr']],
  ['may', 5, []],
  ['june', 6, ['jun']],
  ['july', 7, ['jul']],
  ['august', 8, ['aug']],
  ['september', 9, ['sep', 'sept']],
  ['october', 10, ['oct']],
  ['november', 11, ['nov']],
  ['december', 12, ['dec']],
];

const MONTH_TOKEN_TO_INFO = new Map(
  MONTHS.flatMap(([name, month, aliases]) => [[name, { name, month }], ...aliases.map((alias) => [alias, { name, month }])])
);

const MONTH_PATTERN = new RegExp(
  `\\b(${[...MONTH_TOKEN_TO_INFO.keys()]
    .sort((left, right) => right.length - left.length)
    .join('|')})\\.?(\\s*,\\s*|\\s+)(\\d{2,4})\\b`,
  'gi'
);

function padNumber(value) {
  return String(value).padStart(2, '0');
}

function normalizeYearToken(yearToken, separator = '') {
  const numericYear = Number(yearToken);
  if (!Number.isInteger(numericYear)) {
    return null;
  }

  if (yearToken.length === 4) {
    return numericYear;
  }

  if (yearToken.length === 2) {
    if (!separator.includes(',')) {
      return null;
    }

    return numericYear <= 69 ? 2000 + numericYear : 1900 + numericYear;
  }

  return null;
}

function buildMonthRange(year, month) {
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;

  return {
    startDate: `${year}-${padNumber(month)}-01`,
    endExclusive: `${nextYear}-${padNumber(nextMonth)}-01`,
  };
}

// Hints version 2: a "<Month> <Year>" match that is only part of a date
// phrase the resolver does not understand is dropped instead of being
// resolved to the whole month. Day ranges and as-of days ("between 1 and 10
// March 2026", "Today is 15 February 2026"), month ranges and lists sharing a
// year ("January to March 2026", "between November 2025 and February 2026",
// "January and February 2026"), anchors ("as of", "since", "before", "until")
// and to-date phrases ("March 2026 to date") all made the whole-month range
// wrong; the model reads such a phrase itself (business rule 4). A month
// with its own year next to another one ("March 2025 and March 2026") is
// still resolved.
const MONTH_ALTERNATION = [...MONTH_TOKEN_TO_INFO.keys()].sort((left, right) => right.length - left.length).join('|');
const RANGE_CONNECTOR = '(?:-|–|—|to|through|thru|until|till)';
const LIST_CONNECTOR = '(?:,|and|or|&)';
const DAY_OF_MONTH = '\\d{1,2}(?:st|nd|rd|th)?';
const PARTIAL_BEFORE_PATTERNS = [
  // A day of the month right before: "15 February 2026", "1 and 10 March 2026".
  new RegExp(`\\b${DAY_OF_MONTH}\\s+(?:of\\s+)?$`, 'i'),
  // The end of a month range: "January to March 2026", "November 2025 through February 2026".
  new RegExp(`\\b(?:${MONTH_ALTERNATION})\\.?(?:\\s*,?\\s*\\d{2,4})?\\s*${RANGE_CONNECTOR}\\s*$`, 'i'),
  // A month without its own year shares this one: "January and February 2026".
  new RegExp(`\\b(?:${MONTH_ALTERNATION})\\.?\\s*${LIST_CONNECTOR}\\s*$`, 'i'),
  // The end of "between <month> [year] and <month> <year>".
  new RegExp(`\\bbetween\\s+(?:the\\s+)?(?:${DAY_OF_MONTH}\\s+(?:of\\s+)?)?(?:${MONTH_ALTERNATION})\\.?(?:\\s*,?\\s*\\d{2,4})?\\s+and\\s*$`, 'i'),
  // An anchor, not a window: "as of", "since", "before", "until", "end of".
  /\b(?:as of|as at|today is|since|before|after|until|till|up to|prior to|through|thru|end of|start of|beginning of)\s+(?:the\s+)?$/i,
];
const PARTIAL_AFTER_PATTERNS = [
  // The start of a range: "November 2025 through February 2026", "1 March 2026 to 10 March 2026".
  new RegExp(`^\\s*${RANGE_CONNECTOR}\\s*(?:the\\s+)?(?:${DAY_OF_MONTH}\\s+(?:of\\s+)?)?(?:${MONTH_ALTERNATION})\\b`, 'i'),
  // To-date and open-ended phrases: "March 2026 to date", "March 2026 onwards".
  /^\s*(?:to date|so far|onwards?|and later|or later|and earlier|or earlier)\b/i,
];
const BETWEEN_START_PATTERN = new RegExp(
  `^\\s*and\\s+(?:the\\s+)?(?:${DAY_OF_MONTH}\\s+(?:of\\s+)?)?(?:${MONTH_ALTERNATION})\\b`,
  'i'
);

function isPartialMonthReference(text, startIndex, matchedText) {
  const before = text.slice(0, startIndex);
  const after = text.slice(startIndex + matchedText.length);
  if (PARTIAL_BEFORE_PATTERNS.some((pattern) => pattern.test(before))) {
    return true;
  }
  if (PARTIAL_AFTER_PATTERNS.some((pattern) => pattern.test(after))) {
    return true;
  }
  // The start of "between <month> <year> and <month> <year>".
  return /\bbetween\s+(?:the\s+)?$/i.test(before) && BETWEEN_START_PATTERN.test(after);
}

/**
 * Whole-month references ("March 2026", "Feb, 26") in `question`, each with
 * its half-open range. `hintsVersion` 2 (the default) drops a match that is
 * only part of a longer date phrase (see isPartialMonthReference); version 1
 * resolves every match.
 */
export function extractTemporalReferences(question, { hintsVersion = undefined } = {}) {
  const version = normalizeHintsVersion(hintsVersion);
  const temporalReferences = [];
  const text = String(question || '');

  for (const match of text.matchAll(MONTH_PATTERN)) {
    const monthToken = String(match[1] || '').toLowerCase();
    const separator = String(match[2] || '');
    const monthInfo = MONTH_TOKEN_TO_INFO.get(monthToken);
    const year = normalizeYearToken(String(match[3] || ''), separator);

    if (!monthInfo || !year) {
      continue;
    }
    if (version !== 1 && isPartialMonthReference(text, match.index ?? 0, match[0])) {
      continue;
    }

    const { startDate, endExclusive } = buildMonthRange(year, monthInfo.month);
    temporalReferences.push({
      kind: 'month',
      originalText: match[0],
      normalizedText: `${monthInfo.name[0].toUpperCase()}${monthInfo.name.slice(1)} ${year}`,
      month: monthInfo.month,
      monthName: `${monthInfo.name[0].toUpperCase()}${monthInfo.name.slice(1)}`,
      year,
      startDate,
      endExclusive,
      startIndex: match.index ?? null,
    });
  }

  return temporalReferences;
}

function normalizeQuestionTemporalText(question, temporalReferences) {
  if (!Array.isArray(temporalReferences) || temporalReferences.length === 0) {
    return String(question || '');
  }

  let normalized = String(question || '');
  for (const reference of temporalReferences) {
    normalized = normalized.replaceAll(reference.originalText, reference.normalizedText);
  }

  return normalized;
}

/**
 * The question as retrieval and the semantic plan read it: the original and
 * the temporally normalized text, its lexical tokens and the resolved
 * temporal references. `hintsVersion` (src/hints-version.js; default 2)
 * selects how dates are resolved and which tokens retrieval ignores.
 */
export function buildQuestionContext(question, { hintsVersion = undefined } = {}) {
  const version = normalizeHintsVersion(hintsVersion);
  const originalQuestion = String(question || '');
  const temporalReferences = extractTemporalReferences(originalQuestion, { hintsVersion: version });
  const normalizedQuestion = normalizeQuestionTemporalText(originalQuestion, temporalReferences);

  const tokens = normalizeTokens(normalizedQuestion);
  return {
    originalQuestion,
    normalizedQuestion,
    questionTokens: version === 1 ? tokens : tokens.filter((token) => !RETRIEVAL_STOPWORDS_V2.has(token)),
    temporalReferences,
  };
}

function normalizedPhrase(value) {
  return splitWords(value).join(' ');
}

function buildQuestionWordIndex(questionContext) {
  return splitWords(questionContext.normalizedQuestion).map((word) => ({
    word,
    singular: singularTokenVariant(word),
    variants: tokenVariants(word),
    isStopword: STOPWORDS.has(word),
  }));
}

function buildSynonymWord(word) {
  return {
    word,
    singular: singularTokenVariant(word),
    variants: tokenVariants(word),
    exactOnly: word.length <= 1 || STOPWORDS.has(word),
  };
}

// One synonym word against one question word: exact, singular/plural, or a
// shared morphological variant ("moved" ~ "move", "selling" ~ "sell").
// Stopwords and one-letter words must match exactly, so the "without" in
// "without postings" is significant.
function synonymWordMatches(questionWord, synonymWord) {
  if (questionWord.word === synonymWord.word) {
    return true;
  }
  if (synonymWord.exactOnly || questionWord.isStopword) {
    return false;
  }
  if (questionWord.singular === synonymWord.singular) {
    return true;
  }
  for (const variant of questionWord.variants) {
    if (synonymWord.variants.has(variant)) {
      return true;
    }
  }
  return false;
}

// Every place a synonym occurs in the question, as word spans [start, end).
// Multi-word synonyms must match as a contiguous phrase (with per-word
// inflection tolerance). Earlier versions matched multi-word synonyms as an
// unordered bag of non-stopword tokens, so "without postings" fired on any
// question that mentioned postings.
function findSynonymSpans(synonyms, questionWords) {
  const spans = [];

  for (const synonym of synonyms) {
    if (normalizeTokens(synonym).length === 0) {
      continue;
    }

    const synonymWords = splitWords(synonym).map(buildSynonymWord);
    for (let start = 0; start + synonymWords.length <= questionWords.length; start += 1) {
      if (synonymWords.every((synonymWord, offset) => synonymWordMatches(questionWords[start + offset], synonymWord))) {
        spans.push({ synonym, start, end: start + synonymWords.length });
      }
    }
  }

  return spans;
}

function findMatchedSynonyms(entry, questionContext) {
  const synonyms = uniqueStrings([entry.name, ...(entry.synonyms || [])]);
  const matched = new Set(findSynonymSpans(synonyms, buildQuestionWordIndex(questionContext)).map((span) => span.synonym));
  return synonyms.filter((synonym) => matched.has(synonym));
}

/**
 * Longest-span arbitration across semantic-layer entries.
 *
 * When a multi-word synonym of one entry covers a span of the question, shorter
 * synonyms of OTHER entries that fall entirely inside that span do not match:
 * "sales documents" (entity) consumes "sales", so metric net_sales does not
 * fire, and "credit memo" (document type) consumes "credit". Spans are resolved
 * longest first and only surviving spans can suppress others.
 *
 * Exception: metric phrases are compositional ("brand sales", "biggest buyers",
 * "product sales" name a dimension plus a measure), so a metric span does not
 * suppress the entity it mentions.
 */
function arbitrateSemanticSpans(candidates) {
  const spanLength = (span) => span.end - span.start;
  const ordered = [...candidates].sort(
    (left, right) => spanLength(right) - spanLength(left) || left.start - right.start
  );
  const active = [];
  const suppressed = [];

  for (const candidate of ordered) {
    const suppressor = active.find(
      (other) =>
        other.key !== candidate.key &&
        spanLength(other) >= 2 &&
        spanLength(other) > spanLength(candidate) &&
        other.start <= candidate.start &&
        candidate.end <= other.end &&
        !(other.kind === 'metric' && candidate.kind === 'entity')
    );

    if (suppressor) {
      suppressed.push({ ...candidate, suppressedBy: { key: suppressor.key, synonym: suppressor.synonym } });
      continue;
    }
    active.push(candidate);
  }

  return { active, suppressed };
}

// Count / list / existence phrasings. In such a question a metric word can
// describe which rows to count ("How many debit postings") rather than the
// measure to aggregate; see classifyMetricEnforcement.
const COUNT_OR_EXISTENCE_INTENT_PATTERNS = [
  /\bhow many\b/,
  /\bnumber of\b/,
  /\bcount\b/,
  /\b(?:do|does|did) not have\b/,
  /\b(?:don|doesn|didn) t have\b/,
  /\b(?:have|has|had) no\b/,
  /\bwithout\b/,
  /\bnever\b/,
  /\bwhich\b.*\bdid we\b/,
  /\b(?:is|are|was|were) there\b/,
];

export function detectCountOrExistenceIntent(question) {
  const text = normalizedPhrase(question);
  return COUNT_OR_EXISTENCE_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Decide whether a matched metric is ENFORCED by the SQL guardrail or only
 * ADVISORY (kept as a prompt hint; a mismatch becomes a trace warning). Both
 * lists are data-driven, per metric, in the semantic layer:
 * - `advisory_synonyms`: generic words ("sales", "sold", "moved") that never
 *   enforce on their own.
 * - `count_advisory_synonyms`: words that name the measure in an aggregate
 *   question but only select rows in a count/list/existence question
 *   ("debit" in "How many debit postings"). They enforce unless the question
 *   has count/existence intent.
 * Every other synonym is an explicit metric phrase ("net sales", "revenue",
 * "units sold") and enforces in every kind of question.
 */
function classifyMetricEnforcement(entry, matchedSynonyms, countIntent) {
  const advisory = new Set(uniqueStrings(entry.advisory_synonyms).map(normalizedPhrase));
  const countAdvisory = new Set(uniqueStrings(entry.count_advisory_synonyms).map(normalizedPhrase));
  const advisoryMatches = matchedSynonyms.filter((synonym) => advisory.has(normalizedPhrase(synonym)));
  const explicitMatches = matchedSynonyms.filter((synonym) => !advisory.has(normalizedPhrase(synonym)));

  if (explicitMatches.length === 0) {
    return { enforcement: 'advisory', enforcementReason: 'generic_terms_only', explicitMatches, advisoryMatches };
  }
  if (countIntent && explicitMatches.every((synonym) => countAdvisory.has(normalizedPhrase(synonym)))) {
    return { enforcement: 'advisory', enforcementReason: 'count_or_existence_intent', explicitMatches, advisoryMatches };
  }
  return { enforcement: 'enforced', enforcementReason: 'explicit_metric_phrase', explicitMatches, advisoryMatches };
}

function semanticMatchScore(matchedSynonyms) {
  return matchedSynonyms.reduce((score, synonym) => score + Math.max(1, normalizeTokens(synonym).length), 0);
}

function summarizeSemanticEntry(entry, matchedSynonyms) {
  return {
    name: entry.name,
    matchedSynonyms,
    preferredTables: entry.preferred_tables || [],
    displayColumns: entry.display_columns || [],
    preferredColumns: entry.preferred_columns || [],
    preferredExpression: entry.preferred_expression || null,
    defaultFilters: entry.default_filters || [],
    notes: entry.notes || [],
    score: semanticMatchScore(matchedSynonyms),
  };
}

function summarizeFilterHint(filterHint, matchedSynonyms) {
  return {
    name: filterHint.name,
    matchedValues: matchedSynonyms,
    targetTable: filterHint.target_table || null,
    targetColumns: filterHint.target_columns || [],
    operator: filterHint.operator || null,
    notes: filterHint.notes || [],
    score: semanticMatchScore(matchedSynonyms),
  };
}

function buildFilterHintMatchEntry(filterHint, semanticLayer) {
  const baseSynonyms = uniqueStrings(filterHint.synonyms || []);
  const baseSynonymSet = new Set(baseSynonyms.map((value) => splitWords(value).join(' ')));
  const filterColumns = new Set(filterHint.target_columns || []);
  const aliasValues = (semanticLayer.value_aliases || [])
    .filter((alias) => {
      if (filterHint.target_table === 'Product' && alias.entity === 'product') {
        return true;
      }

      return (alias.target_columns || []).some((column) => filterColumns.has(column));
    })
    .flatMap((alias) => [alias.canonical_value, ...(alias.aliases || [])]);
  const aliasOnlyValues = aliasValues.filter((value) => !baseSynonymSet.has(splitWords(value).join(' ')));

  return {
    ...filterHint,
    synonyms: uniqueStrings([...baseSynonyms, ...aliasValues]),
    aliasOnlyValues: uniqueStrings(aliasOnlyValues),
  };
}

function removeSubsumedAliasMatches(matchedSynonyms, aliasOnlyValues) {
  const aliasOnlySet = new Set((aliasOnlyValues || []).map((value) => splitWords(value).join(' ')));
  const matchedTokenSets = matchedSynonyms.map((value) => ({
    value,
    normalized: splitWords(value).join(' '),
    tokens: splitWords(value),
  }));

  return matchedTokenSets
    .filter((entry) => {
      if (!aliasOnlySet.has(entry.normalized)) {
        return true;
      }

      return !matchedTokenSets.some(
        (other) =>
          other.normalized !== entry.normalized &&
          other.tokens.length > entry.tokens.length &&
          entry.tokens.every((token) => other.tokens.includes(token))
      );
    })
    .map((entry) => entry.value);
}

const PRODUCT_CONTEXT_ENTITY_NAMES = new Set(['product', 'brand', 'product_category', 'campaign']);
const PRODUCT_CONTEXT_FILTER_TABLES = new Set(['Product', 'Brand', 'ProductBrand', 'ProductCategory', 'Campaign']);

function addDerivedMetrics(metrics, semanticLayer) {
  const derivedMetrics = [...metrics];
  const metricNames = new Set(derivedMetrics.map((metric) => metric.name));
  const hasGeneralSalesMetric = metricNames.has('net_sales');

  if (hasGeneralSalesMetric && !metricNames.has('line_net_sales')) {
    const lineMetric = (semanticLayer.metrics || []).find((metric) => metric.name === 'line_net_sales');
    const salesMetric = derivedMetrics.find((metric) => metric.name === 'net_sales');
    if (lineMetric) {
      // The derived line-level metric is exactly as strong as the sales match
      // that triggered it.
      derivedMetrics.push({
        ...summarizeSemanticEntry(lineMetric, ['sales with product filter context']),
        enforcement: salesMetric.enforcement,
        enforcementReason: salesMetric.enforcementReason,
        derivedFrom: 'net_sales',
      });
    }
  }

  return derivedMetrics;
}

// Metrics measured on ledger postings (the debit and credit metrics).
const LEDGER_METRIC_GRAINS = new Set(['accounting_posting']);

/**
 * Hints version 2: in a question about ledger postings (a debit or credit
 * metric matched), a sales metric is not what the question measures: its
 * words name an account ("account 4000 (Sales Revenue)") or a document
 * filter ("postings of sales dated ..."). Such a sales metric stays a prompt
 * hint but no longer enforces (enforcementReason 'ledger_metric_context'), so
 * the METRIC_COLUMN guardrail cannot reject every correct ledger answer
 * (tpl_revenue_credits_monthly_q1_2026_e1b20a, flagged
 * known_validator_rejection: METRIC_COLUMN under version 1). The derived
 * line-level metric inherits the demotion.
 */
function withLedgerContextArbitration(metrics, matches) {
  const grainOf = new Map(matches.filter((match) => match.kind === 'metric').map((match) => [match.entry.name, match.entry.grain || null]));
  if (!metrics.some((metric) => LEDGER_METRIC_GRAINS.has(grainOf.get(metric.name)))) {
    return metrics;
  }
  return metrics.map((metric) =>
    metric.enforcement === 'enforced' && !LEDGER_METRIC_GRAINS.has(grainOf.get(metric.name))
      ? { ...metric, enforcement: 'advisory', enforcementReason: 'ledger_metric_context' }
      : metric
  );
}

/**
 * Hints version 2: an entity whose every matched word lies inside the span of
 * a matched metric measured at that entity's grain names the metric's grain,
 * not something to list ("sales" in "What were sales in March 2026?" is
 * net_sales over sales documents; "order" in "average order value"). Such an
 * entity keeps its tables and default filters but loses its display columns,
 * which invited one row per document (hard_ambiguous_sales_mar_2026,
 * tpl_outstanding_balance_mar_2026_c15bb6). A metric phrase that names
 * another entity ("biggest buyers": net sales per customer) keeps that
 * entity's display columns.
 */
function withoutGrainDisplayColumns(entities, matches, activeSpans) {
  const grainOf = new Map(matches.filter((match) => match.kind === 'metric').map((match) => [match.key, match.entry.grain || null]));
  const metricSpans = activeSpans.filter((span) => span.kind === 'metric');
  const entityKeyOf = new Map(matches.filter((match) => match.kind === 'entity').map((match) => [match.entry.name, match.key]));
  return entities.map((entity) => {
    const spans = activeSpans.filter((span) => span.key === entityKeyOf.get(entity.name));
    const consumedBy = (span) =>
      metricSpans.find((metric) => grainOf.get(metric.key) === entity.name && metric.start <= span.start && span.end <= metric.end);
    const consumers = spans.map(consumedBy);
    if (entity.displayColumns.length === 0 || spans.length === 0 || consumers.some((consumer) => !consumer)) {
      return entity;
    }
    return { ...entity, displayColumns: [], displayColumnsSuppressedBy: uniqueStrings(consumers.map((consumer) => consumer.entryName)) };
  });
}

function findSemanticJoinHints(joinPaths, requiredTables) {
  const required = new Set(requiredTables);

  return (Array.isArray(joinPaths) ? joinPaths : [])
    .filter((joinPath) => joinPath.tables.every((tableName) => required.has(tableName)))
    .map((joinPath) => ({
      name: joinPath.name,
      tables: joinPath.tables,
      joinSql: joinPath.join_sql,
    }));
}

function findMatchedClarificationRules(clarificationRules, questionContext) {
  return (Array.isArray(clarificationRules) ? clarificationRules : [])
    .map((rule) => ({
      trigger: String(rule?.trigger || '').trim(),
      questions: uniqueStrings(rule?.questions),
    }))
    .filter((rule) => rule.trigger && rule.questions.length > 0)
    .map((rule) => ({
      ...rule,
      matchedTriggers: findMatchedSynonyms({ name: rule.trigger, synonyms: [rule.trigger] }, questionContext),
    }))
    .filter((rule) => rule.matchedTriggers.length > 0);
}

function matchSemanticLayer(semanticLayer, questionContext) {
  const questionWords = buildQuestionWordIndex(questionContext);
  const sources = [
    ...(semanticLayer.entities || []).map((entry) => ({ kind: 'entity', entry, matchEntry: entry })),
    ...(semanticLayer.metrics || []).map((entry) => ({ kind: 'metric', entry, matchEntry: entry })),
    ...(semanticLayer.filter_hints || []).map((entry) => ({
      kind: 'filter',
      entry,
      matchEntry: buildFilterHintMatchEntry(entry, semanticLayer),
    })),
  ].map((source, index) => ({
    ...source,
    key: `${source.kind}:${source.entry.name}:${index}`,
    synonyms: uniqueStrings([source.matchEntry.name, ...(source.matchEntry.synonyms || [])]),
  }));

  const candidates = sources.flatMap((source) =>
    findSynonymSpans(source.synonyms, questionWords).map((span) => ({
      ...span,
      key: source.key,
      kind: source.kind,
      entryName: source.entry.name,
    }))
  );
  const { active, suppressed } = arbitrateSemanticSpans(candidates);

  const matches = sources
    .map((source) => {
      const activeSynonyms = new Set(active.filter((span) => span.key === source.key).map((span) => span.synonym));
      return { ...source, matchedSynonyms: source.synonyms.filter((synonym) => activeSynonyms.has(synonym)) };
    })
    .filter((source) => source.matchedSynonyms.length > 0);

  return {
    matches,
    activeSpans: active,
    suppressedMatches: suppressed.map((span) => ({
      kind: span.kind,
      name: span.entryName,
      synonym: span.synonym,
      suppressedBy: sources.find((source) => source.key === span.suppressedBy.key)?.entry.name || null,
      suppressedBySynonym: span.suppressedBy.synonym,
    })),
  };
}

/**
 * The semantic plan of `question`: matched entities, metrics (with their
 * guardrail enforcement), filter hints, join hints and clarification rules.
 * `hintsVersion` (src/hints-version.js; default 2) selects the semantic layer
 * (version 2 applies metadata/semantic-layer.hints-v2.json) and the v2
 * arbitration; a version-2 plan says so in `hintsVersion`, a version-1 plan
 * is exactly the plan every run had before HINTS_VERSION existed.
 */
export function buildSemanticPlan(question, { questionContext = null, semanticLayer = undefined, hintsVersion = undefined } = {}) {
  const version = normalizeHintsVersion(hintsVersion);
  const layer = semanticLayer ?? loadSemanticLayerForHintsVersion(version);
  const context = questionContext || buildQuestionContext(question, { hintsVersion: version });
  const countIntent = detectCountOrExistenceIntent(context.normalizedQuestion);
  const { matches, activeSpans, suppressedMatches } = matchSemanticLayer(layer, context);
  let entities = matches
    .filter((match) => match.kind === 'entity')
    .map((match) => summarizeSemanticEntry(match.entry, match.matchedSynonyms));
  if (version !== 1) {
    entities = withoutGrainDisplayColumns(entities, matches, activeSpans);
  }
  let metrics = matches
    .filter((match) => match.kind === 'metric')
    .map((match) => ({
      ...summarizeSemanticEntry(match.entry, match.matchedSynonyms),
      ...classifyMetricEnforcement(match.entry, match.matchedSynonyms, countIntent),
    }));
  if (version !== 1) {
    metrics = withLedgerContextArbitration(metrics, matches);
  }
  const filterHints = matches
    .filter((match) => match.kind === 'filter')
    .map((match) => [match.entry, removeSubsumedAliasMatches(match.matchedSynonyms, match.matchEntry.aliasOnlyValues)])
    .filter(([, matchedSynonyms]) => matchedSynonyms.length > 0)
    .map(([entry, matchedSynonyms]) => summarizeFilterHint(entry, matchedSynonyms));
  const hasProductContext =
    entities.some((entry) => PRODUCT_CONTEXT_ENTITY_NAMES.has(entry.name)) ||
    filterHints.some((entry) => PRODUCT_CONTEXT_FILTER_TABLES.has(entry.targetTable));
  if (hasProductContext) {
    metrics = addDerivedMetrics(metrics, layer);
  }

  const requiredTables = uniqueStrings([
    ...entities.flatMap((entry) => entry.preferredTables),
    ...metrics.flatMap((entry) => entry.preferredTables),
    ...filterHints.map((entry) => entry.targetTable).filter(Boolean),
  ]);
  const preferredColumns = uniqueStrings([
    ...entities.flatMap((entry) => entry.displayColumns),
    ...metrics.flatMap((entry) => entry.preferredColumns),
    ...filterHints.flatMap((entry) => entry.targetColumns),
  ]);
  const defaultFilters = uniqueStrings([
    ...entities.flatMap((entry) => entry.defaultFilters),
    // Version 2: a metric's own default filters (units count product lines
    // only, canceled documents excluded) apply even when no entity matched.
    ...(version === 1 ? [] : metrics.flatMap((entry) => entry.defaultFilters)),
  ]);

  const plan = {
    version: layer.version ?? null,
    entities,
    metrics,
    filterHints,
    requiredTables,
    preferredColumns,
    defaultFilters,
    clarificationRules: findMatchedClarificationRules(layer.clarification_rules || [], context),
    joinHints: findSemanticJoinHints(layer.join_paths || [], requiredTables),
    countIntent,
    suppressedMatches,
  };
  // Only a version-2 plan is marked: a version-1 plan stays byte for byte the
  // plan of the runs before HINTS_VERSION existed (absent = 1).
  return version === 1 ? plan : { ...plan, hintsVersion: version };
}

function buildSemanticTableBoosts(semanticPlan) {
  const boosts = new Map();
  const addBoost = (tableName, score, reason, sourceName) => {
    if (!tableName) {
      return;
    }

    const current = boosts.get(tableName) || { score: 0, matches: [] };
    current.score += score;
    current.matches.push({ reason, sourceName, score });
    boosts.set(tableName, current);
  };

  for (const entity of semanticPlan.entities || []) {
    for (const tableName of entity.preferredTables || []) {
      addBoost(tableName, 60 + entity.score * 4, 'semantic_entity', entity.name);
    }
  }

  for (const metric of semanticPlan.metrics || []) {
    for (const tableName of metric.preferredTables || []) {
      addBoost(tableName, 80 + metric.score * 5, 'semantic_metric', metric.name);
    }
  }

  for (const filterHint of semanticPlan.filterHints || []) {
    addBoost(filterHint.targetTable, 70 + filterHint.score * 5, 'semantic_filter_hint', filterHint.name);
  }

  for (const joinHint of semanticPlan.joinHints || []) {
    for (const tableName of joinHint.tables || []) {
      addBoost(tableName, 20, 'semantic_join_hint', joinHint.name);
    }
  }

  return boosts;
}

function scoreColumn(column, questionTokens) {
  let score = 0;
  const nameTokens = normalizeTokens(column.name);
  const commentTokens = normalizeTokens(column.comment || '');

  if (column.primaryKey) {
    score += 100;
  }

  if (column.references) {
    score += 80;
  }

  if (/(date|time|name|code|type|status|qty|quantity|price|amount|total|net|paid|balance|tax|gst|discount|credit|debit|location|customer|item|account|address|email|phone|active|cancel)/i.test(column.name)) {
    score += 25;
  }

  for (const token of questionTokens) {
    if (nameTokens.includes(token)) {
      score += 35;
    }
    if (commentTokens.includes(token)) {
      score += 20;
    }
  }

  return score;
}

// Hints version 2: "account" is not a Customer alias (in this schema it names
// a ledger account; tpl_account_net_movement_feb_2026_c1256b read "each
// account" as each customer), matching the overlay's customer entity.
const TABLE_ALIAS_REMOVALS_V2 = { Customer: new Set(['account', 'accounts']) };

function tableAliases(tableName, hintsVersion) {
  const aliases = TABLE_ALIASES[tableName] || [];
  const removed = hintsVersion === 1 ? null : TABLE_ALIAS_REMOVALS_V2[tableName];
  return removed ? aliases.filter((alias) => !removed.has(alias)) : aliases;
}

function buildTableIndex(table, hintsVersion = 1) {
  return {
    nameTokens: normalizeTokens(table.name),
    descriptionTokens: normalizeTokens(table.description || ''),
    aliasTokens: normalizeTokens(tableAliases(table.name, hintsVersion).join(' ')),
    columnNameTokens: normalizeTokens(table.columns.map((column) => column.name).join(' ')),
    columnCommentTokens: normalizeTokens(table.columns.map((column) => column.comment || '').join(' ')),
  };
}

export function scoreTableDetailed(table, questionTokens, { hintsVersion = undefined } = {}) {
  const index = buildTableIndex(table, normalizeHintsVersion(hintsVersion));
  let score = 0;
  const matches = [];

  for (const token of questionTokens) {
    let tokenScore = 0;
    const reasons = [];

    if (index.nameTokens.includes(token)) {
      tokenScore += 30;
      reasons.push('table_name');
    }
    if (index.aliasTokens.includes(token)) {
      tokenScore += 28;
      reasons.push('table_alias');
    }
    if (index.descriptionTokens.includes(token)) {
      tokenScore += 18;
      reasons.push('table_description');
    }
    if (index.columnNameTokens.includes(token)) {
      tokenScore += 10;
      reasons.push('column_name');
    }
    if (index.columnCommentTokens.includes(token)) {
      tokenScore += 6;
      reasons.push('column_comment');
    }

    if (tokenScore > 0) {
      matches.push({
        token,
        score: tokenScore,
        reasons,
      });
      score += tokenScore;
    }
  }

  return {
    score,
    matches,
  };
}

function scoreTable(table, questionTokens, hintsVersion) {
  return scoreTableDetailed(table, questionTokens, { hintsVersion }).score;
}

function getImportantColumns(table, questionTokens, limit = 24) {
  const scored = table.columns
    .map((column) => ({
      column,
      score: scoreColumn(column, questionTokens),
    }))
    .sort((left, right) => right.score - left.score || left.column.name.localeCompare(right.column.name));

  const selected = [];
  const seen = new Set();

  for (const entry of scored) {
    if (selected.length >= limit) {
      break;
    }

    if (entry.score <= 0 && selected.length >= 12) {
      break;
    }

    if (!seen.has(entry.column.name)) {
      selected.push(entry.column);
      seen.add(entry.column.name);
    }
  }

  for (const column of table.columns) {
    if (selected.length >= limit) {
      break;
    }

    if (!seen.has(column.name) && (column.primaryKey || column.references)) {
      selected.push(column);
      seen.add(column.name);
    }
  }

  return selected;
}

function formatColumn(column) {
  const parts = [column.name, column.type].filter(Boolean);

  if (column.primaryKey) {
    parts.push('PK');
  }
  if (column.references) {
    parts.push(`FK -> ${column.references.model}.${column.references.key}`);
  }
  if (column.allowNull === false) {
    parts.push('NOT NULL');
  }
  if (column.comment) {
    parts.push(`comment: ${column.comment}`);
  }

  return `- ${parts.join(' | ')}`;
}

function formatColumnNameChunks(columns, chunkSize = 12) {
  const lines = [];

  for (let index = 0; index < columns.length; index += chunkSize) {
    lines.push(`- ${columns.slice(index, index + chunkSize).map((column) => column.name).join(', ')}`);
  }

  return lines;
}

function summarizeColumn(column) {
  return {
    name: column.name,
    type: column.type || null,
    primaryKey: Boolean(column.primaryKey),
    allowNull: column.allowNull ?? null,
    comment: column.comment || null,
    references: column.references
      ? {
          model: column.references.model,
          key: column.references.key,
        }
      : null,
  };
}

function buildRelationshipSummary(tables) {
  const relationships = [];

  for (const table of tables) {
    for (const foreignKey of table.foreignKeys) {
      relationships.push({
        fromTable: table.tableName,
        fromColumn: foreignKey.column,
        toTable: foreignKey.references.model,
        toColumn: foreignKey.references.key,
      });
    }
  }

  return relationships;
}

function formatRelationships(relationships) {
  return relationships.length > 0
    ? relationships
        .map((relationship) => `- ${relationship.fromTable}.${relationship.fromColumn} -> ${relationship.toTable}.${relationship.toColumn}`)
        .join('\n')
    : '- No in-scope foreign keys';
}

function buildTableContextSummary(table, questionTokens) {
  const columns = getImportantColumns(table, questionTokens);
  const selectedNames = new Set(columns.map((column) => column.name));
  const omittedColumns = table.columns.filter((column) => !selectedNames.has(column.name));
  const lines = [
    `Table ${table.tableName}`,
    table.description ? `Description: ${table.description}` : null,
    'Columns:',
    ...columns.map(formatColumn),
    omittedColumns.length > 0 ? 'Other available columns (names only):' : null,
    ...formatColumnNameChunks(omittedColumns),
  ].filter(Boolean);

  return {
    name: table.name,
    tableName: table.tableName,
    file: table.file || null,
    description: table.description || null,
    totalColumnCount: table.columns.length,
    includedColumns: columns.map(summarizeColumn),
    omittedColumnNames: omittedColumns.map((column) => column.name),
    text: lines.join('\n'),
  };
}

function buildPromptContext(tables, questionTokens) {
  const tableContexts = tables.map((table) => buildTableContextSummary(table, questionTokens));
  const relationships = buildRelationshipSummary(tables);

  return {
    questionTokens,
    allowedTables: tables.map((table) => table.tableName),
    relationships,
    relationshipText: formatRelationships(relationships),
    tables: tableContexts.map(({ text, ...tableContext }) => tableContext),
    tableBlocks: tableContexts.map((tableContext) => tableContext.text).join('\n\n'),
  };
}

function buildForeignKeyGraph(tables) {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const adjacency = new Map(tables.map((table) => [table.name, new Set()]));

  for (const table of tables) {
    for (const foreignKey of table.foreignKeys) {
      const targetName = foreignKey.references.model;
      if (!byName.has(targetName)) {
        continue;
      }

      adjacency.get(table.name).add(targetName);
      adjacency.get(targetName).add(table.name);
    }
  }

  return {
    byName,
    adjacency,
  };
}

function findShortestJoinPath(adjacency, start, goal, maxDepth = 3) {
  if (start === goal) {
    return [start];
  }

  const queue = [{ name: start, path: [start], depth: 0 }];
  const visited = new Set([start]);

  while (queue.length > 0) {
    const current = queue.shift();
    const neighbors = [...(adjacency.get(current.name) || [])].sort();

    for (const neighbor of neighbors) {
      if (visited.has(neighbor)) {
        continue;
      }

      const nextPath = [...current.path, neighbor];
      if (neighbor === goal) {
        return nextPath;
      }

      if (current.depth + 1 < maxDepth) {
        visited.add(neighbor);
        queue.push({
          name: neighbor,
          path: nextPath,
          depth: current.depth + 1,
        });
      }
    }
  }

  return null;
}

function expandTablesForJoinPaths(tables, selectedNames, maxJoinPathHops = 3) {
  if (!Array.isArray(selectedNames) || selectedNames.length <= 1) {
    return {
      tables: tables.filter((table) => selectedNames.includes(table.name)),
      connectorTableNames: [],
    };
  }

  const { adjacency } = buildForeignKeyGraph(tables);
  const selectedSet = new Set(selectedNames);
  const expanded = new Set(selectedNames);
  const connectorTableNames = new Set();

  for (let leftIndex = 0; leftIndex < selectedNames.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < selectedNames.length; rightIndex += 1) {
      const path = findShortestJoinPath(
        adjacency,
        selectedNames[leftIndex],
        selectedNames[rightIndex],
        maxJoinPathHops
      );
      if (!path) {
        continue;
      }

      for (const pathTableName of path) {
        expanded.add(pathTableName);
        if (!selectedSet.has(pathTableName)) {
          connectorTableNames.add(pathTableName);
        }
      }
    }
  }

  return {
    tables: tables.filter((table) => expanded.has(table.name)),
    connectorTableNames: [...connectorTableNames].map((name) => tables.find((table) => table.name === name)?.tableName || name),
  };
}

export function retrieveRelevantTables(
  schema,
  question,
  { maxTables = 4, maxJoinPathHops = 3, questionContext = null, semanticPlan = null, hintsVersion = undefined } = {}
) {
  const version = normalizeHintsVersion(hintsVersion);
  const resolvedQuestionContext = questionContext || buildQuestionContext(question, { hintsVersion: version });
  const { questionTokens } = resolvedQuestionContext;
  const resolvedSemanticPlan = semanticPlan || buildSemanticPlan(question, { questionContext: resolvedQuestionContext, hintsVersion: version });
  const semanticBoosts = buildSemanticTableBoosts(resolvedSemanticPlan);
  const scored = schema.tables
    .map((table) => {
      const lexicalScore = scoreTable(table, questionTokens, version);
      const semanticBoost = semanticBoosts.get(table.tableName) || semanticBoosts.get(table.name) || { score: 0, matches: [] };

      return {
        table,
        lexicalScore,
        semanticScore: semanticBoost.score,
        semanticMatches: semanticBoost.matches,
        score: lexicalScore + semanticBoost.score,
      };
    })
    .sort((left, right) => right.score - left.score || left.table.name.localeCompare(right.table.name));

  const topSelected = scored
    .filter((entry) => entry.score > 0)
    .slice(0, maxTables)
    .map((entry) => entry.table.name);

  // Tables a matched entity/metric/filter explicitly requires (e.g. SalesDocumentLine
  // for line_net_sales) must survive the score cap, otherwise a strong entity like
  // "brand" can crowd out the line-level table the metric actually needs and the SQL
  // gets rejected as out-of-scope. Appended in score order after the top-N.
  const requiredTableNames = new Set(resolvedSemanticPlan.requiredTables || []);
  const requiredSelected = scored
    .filter((entry) => requiredTableNames.has(entry.table.name) && !topSelected.includes(entry.table.name))
    .map((entry) => entry.table.name);
  const selected = uniqueStrings([...topSelected, ...requiredSelected]);

  const baseSelected =
    selected.length > 0
      ? selected
      : schema.tables.slice(0, Math.min(maxTables, schema.tables.length)).map((table) => table.name);

  const expanded = expandTablesForJoinPaths(schema.tables, baseSelected, maxJoinPathHops);
  const tables = expanded.tables;

  return {
    normalizedQuestion: resolvedQuestionContext.normalizedQuestion,
    questionTokens,
    temporalReferences: resolvedQuestionContext.temporalReferences,
    tables,
    initialTableNames: baseSelected,
    expandedTableNames: tables.map((table) => table.tableName),
    connectorTableNames: expanded.connectorTableNames,
    fallbackToDefaultSelection: selected.length === 0,
    semanticPlan: resolvedSemanticPlan,
    tableScores: scored.map((entry) => ({
      name: entry.table.name,
      tableName: entry.table.tableName,
      score: entry.score,
      lexicalScore: entry.lexicalScore,
      semanticScore: entry.semanticScore,
      semanticMatches: entry.semanticMatches,
    })),
  };
}

// Tables referenced by a SQL statement, read from the shared MariaDB tokenizer:
// FROM / JOIN / STRAIGHT_JOIN targets and every table of a comma-separated FROM
// list, in order of appearance. CTE names (query-local), derived tables and DUAL
// are not tables; FROM inside EXTRACT/TRIM/SUBSTRING(...) is not a table keyword.
// A db-qualified reference is returned as "db.table".
//
// This is a best-effort helper for trusted SQL (few-shot examples, gold SQL in
// benchmarks): it never throws. The read-only safety layer (validateSqlSafety)
// runs the same analysis in strict mode and fails closed on anything it cannot
// classify.
export function extractTablesFromSql(sql, { alreadyCleaned = false } = {}) {
  const normalizedSql = alreadyCleaned ? String(sql || '') : cleanModelOutput(sql);
  const analysis = analyzeSqlStructure(normalizedSql, { tolerant: true });
  const tables = analysis.tableRefs
    .filter((ref) => ref.kind === 'table')
    .map((ref) => (ref.schema ? `${ref.schema}.${ref.name}` : ref.name));

  return [...new Set(tables)];
}

function scoreExample(example, questionTokens) {
  const exampleTokens = normalizeTokens(example.question);
  const matchedTokens = questionTokens.filter((token) => exampleTokens.includes(token));
  return {
    score: matchedTokens.length,
    matchedTokens,
  };
}

// Few-shot selection reads the version-1 tokens in every hints version: the
// example pool and how it is picked are held fixed across the A/B.
export function retrieveRelevantExamples(question, { maxExamples = 2, minScore = 1 } = {}) {
  const questionTokens = buildQuestionContext(question, { hintsVersion: 1 }).questionTokens;

  return FEW_SHOT_EXAMPLES.map((example) => {
    const scored = scoreExample(example, questionTokens);
    return {
      ...example,
      tables: Array.isArray(example.tables) ? example.tables : extractTablesFromSql(example.sql),
      score: scored.score,
      matchedTokens: scored.matchedTokens,
    };
  })
    .filter((example) => example.score >= minScore)
    .sort((left, right) => right.score - left.score || left.question.localeCompare(right.question))
    .slice(0, maxExamples);
}

function formatExamples(examples) {
  if (!examples || examples.length === 0) {
    return 'No closely matched examples were selected for this question.';
  }

  return examples
    .map(
      (example, index) =>
        `Example ${index + 1}:\nQ: ${example.question}\nTables: ${example.tables.join(', ')}\nSQL:\n${example.sql}`
    )
    .join('\n\n');
}

function formatTemporalReferences(temporalReferences) {
  if (!Array.isArray(temporalReferences) || temporalReferences.length === 0) {
    return '- No explicit temporal references were resolved.';
  }

  return temporalReferences
    .map(
      (reference) =>
        `- "${reference.originalText}" => ${reference.normalizedText}; if the query needs a date filter, use the appropriate in-scope date column with a half-open range like date_col >= '${reference.startDate}' AND date_col < '${reference.endExclusive}'`
    )
    .join('\n');
}

// Version 1 said "counts and lists do not need it" for every advisory match,
// also for "How many units did we sell" (a SUM of quantity). Version 2 says
// which kind of weak match it is.
function advisoryMetricNote(metric, hintsVersion) {
  if (hintsVersion === 1) {
    return ' (weak match: use this measure only if the question asks for it; counts and lists do not need it)';
  }
  if (metric.enforcementReason === 'count_or_existence_intent') {
    return ' (weak match: the question counts or lists rows; use this measure only if it also asks for this amount)';
  }
  if (metric.enforcementReason === 'ledger_metric_context') {
    return ' (weak match: the question is about ledger postings, so these words name an account or a filter; use this measure only if the question also asks for it)';
  }
  return ' (weak match on generic wording: use this measure when the question asks for an amount or a quantity, not when it only counts or lists rows)';
}

function formatSemanticHints(semanticPlan, { hintsVersion = 1 } = {}) {
  if (
    !semanticPlan ||
    ((semanticPlan.entities || []).length === 0 &&
      (semanticPlan.metrics || []).length === 0 &&
      (semanticPlan.filterHints || []).length === 0)
  ) {
    return '- No semantic hints matched this question.';
  }

  const lines = [];

  for (const entity of semanticPlan.entities || []) {
    lines.push(
      `- Entity "${entity.name}" matched ${entity.matchedSynonyms.join(', ')}; prefer tables ${entity.preferredTables.join(', ') || 'none'}${
        entity.displayColumns.length > 0 ? ` and display columns ${entity.displayColumns.join(', ')}` : ''
      }${
        entity.defaultFilters.length > 0 ? `; apply default filters ${entity.defaultFilters.join(' AND ')}` : ''
      }.`
    );
  }

  for (const metric of semanticPlan.metrics || []) {
    // An advisory metric matched only generic wording ("sales", "sold") or a
    // count/existence question, so say so instead of steering a COUNT query
    // toward an amount column.
    const advisoryNote = metric.enforcement === 'advisory' ? advisoryMetricNote(metric, hintsVersion) : '';
    // Version 2 also states the metric's default filters and notes (the
    // conventions behind the gold: product lines only for units, canceled
    // documents excluded, which amount column a money word means).
    const defaults =
      hintsVersion !== 1 && (metric.defaultFilters || []).length > 0 ? `; apply default filters ${metric.defaultFilters.join(' AND ')}` : '';
    const notes = hintsVersion !== 1 && (metric.notes || []).length > 0 ? ` ${metric.notes.join(' ')}` : '';
    lines.push(
      `- Metric "${metric.name}" matched ${metric.matchedSynonyms.join(', ')}${advisoryNote}; prefer ${metric.preferredExpression || 'the most direct matching expression'}${
        metric.preferredTables.length > 0 ? ` using tables ${metric.preferredTables.join(', ')}` : ''
      }${defaults}.${notes}`
    );
  }

  for (const filterHint of semanticPlan.filterHints || []) {
    lines.push(
      `- Filter hint "${filterHint.name}" matched ${filterHint.matchedValues.join(', ')}; apply these as alternatives with ${
        filterHint.operator || 'OR'
      } against ${filterHint.targetColumns.join(', ') || filterHint.targetTable}.`
    );
  }

  for (const joinHint of semanticPlan.joinHints || []) {
    lines.push(`- Semantic join "${joinHint.name}": ${joinHint.joinSql}.`);
  }

  for (const rule of semanticPlan.clarificationRules || []) {
    lines.push(
      `- Clarification rule "${rule.trigger}" matched ${rule.matchedTriggers.join(', ')}; if the request remains ambiguous, ask: ${rule.questions.join(' / ')}`
    );
  }

  return lines.join('\n');
}

function formatMasterDataCandidates(masterDataCandidates) {
  const groups = Array.isArray(masterDataCandidates) ? masterDataCandidates : [];
  if (groups.length === 0) {
    return '- No master-data candidates were resolved for this question.';
  }

  const lines = [
    '- Use resolved master-data IDs for filters when the candidates clearly match the user request.',
    '- Do not invent IDs or names beyond the candidate lists below.',
  ];

  for (const group of groups) {
    lines.push(`- Entity "${group.entity}" searched columns: ${(group.searchColumns || []).join(', ') || 'unknown'}.`);
    for (const term of group.terms || []) {
      lines.push(
        `  - Term "${term.term}" expanded to ${term.expandedTerms.join(', ') || term.term}; top candidates:`
      );
      if (!term.candidates || term.candidates.length === 0) {
        lines.push('    - none');
        continue;
      }

      for (const candidate of term.candidates.slice(0, 8)) {
        lines.push(
          `    - ProductId ${candidate.ProductId}; ProductCode ${candidate.ProductCode || 'null'}; ProductName ${candidate.ProductName || 'null'}; score ${candidate.score}; matched ${candidate.matchedValue || 'n/a'} (${candidate.matchType || 'n/a'})`
        );
      }
    }
  }

  return lines.join('\n');
}

const EXACT_SCHEMA_GUARD =
  'IMPORTANT: Use only exact table and column names that appear in the schema context below. Detailed column entries are a ranked subset; you may use another column only when its exact name appears in an "Other available columns" list. Do NOT invent or infer names that are not shown.';

function estimatePromptTokens(text) {
  const length = String(text || '').length;
  return length === 0 ? 0 : Math.ceil(length / 4);
}

// The basic prompt has no semantic hints and does not follow HINTS_VERSION:
// its temporal resolution and tokens are version 1's.
export function buildBasicPrompt(schema, question) {
  const questionContext = buildQuestionContext(question, { hintsVersion: 1 });
  const context = buildPromptContext(schema.tables, questionContext.questionTokens);

  return {
    system: `You are a senior SQL analyst writing MariaDB 10.6 SQL.

Write one read-only SQL query that answers the user's question.
Return ONLY the SQL query.
${NO_SQL_COMMENTS_RULE}
${EXACT_SCHEMA_GUARD}

Resolved temporal references:
${formatTemporalReferences(questionContext.temporalReferences)}

Allowed tables:
${context.allowedTables.map((tableName) => `- ${tableName}`).join('\n')}

Relationships:
${context.relationshipText}

Schema context:
${context.tableBlocks}`,
    user: question,
    context: {
      ...context,
      normalizedQuestion: questionContext.normalizedQuestion,
      temporalReferences: questionContext.temporalReferences,
    },
  };
}

// The schema block's caching note per effective schema scope. The 'retrieved'
// text is the one every prompt had before schema scopes existed (the previous,
// retrieved-scope baseline's prompt version, 0c314451d4b7).
const SCHEMA_PREFIX_NOTES = {
  retrieved: 'In-scope schema context comes first and may be reused across questions with the same retrieved tables.',
  full: 'In-scope schema context comes first: it lists every in-scope table and is the same for every question.',
};

function buildOptimizedSystemPrompt({ effectiveScope = 'retrieved', hintsVersion = 1 } = {}) {
  const rules = businessRulesFor(hintsVersion).map((rule, index) => `${index + 1}. ${rule}`).join('\n');

  return `You are a senior SQL analyst writing MariaDB 10.6 SQL for a retail/distribution demo system.

Write one read-only SQL query using only the provided schema context.
Use only in-scope foreign keys and in-scope tables.
${EXACT_SCHEMA_GUARD}

The user message is arranged for prompt caching:
1. ${SCHEMA_PREFIX_NOTES[effectiveScope] || SCHEMA_PREFIX_NOTES.retrieved}
2. Question-specific context comes after the schema context.
3. The final answer must still answer only the user's current question.

Business rules:
${rules}

Return ONLY a JSON object with this shape:
{
  "sql": "SELECT ...",
  "explanation": "short explanation",
  "tables_used": ["TableA", "TableB"],
  "assumptions": ["any explicit assumption"]
}`;
}

function buildOptimizedSchemaContext(context) {
  return `In-scope schema context:

Allowed tables:
${context.allowedTables.map((tableName) => `- ${tableName}`).join('\n')}

In-scope relationships:
${context.relationshipText}

In-scope schema:
${context.tableBlocks}`;
}

function buildOptimizedQuestionContext({ question, retrieval, rankedContext, masterDataCandidates, examples, hintsVersion }) {
  return `Question-specific context:

Question:
${question}

Resolved temporal references:
${formatTemporalReferences(retrieval.temporalReferences)}

Semantic retrieval hints:
${formatSemanticHints(retrieval.semanticPlan, { hintsVersion })}

Resolved master-data candidates:
${formatMasterDataCandidates(masterDataCandidates)}

Question-ranked schema details:
${rankedContext.tableBlocks}

Few-shot examples:
${examples}`;
}

// Full scope: the schema block above already lists every in-scope table, so
// the question part carries retrieval's output as a one-line hint instead of
// re-printing the retrieved tables (the 'Question-ranked schema details' block
// of the retrieved scope, about a quarter of that prompt; audit D8).
function buildFullScopeQuestionContext({ question, retrieval, relevanceHint, masterDataCandidates, examples, hintsVersion }) {
  return `Question-specific context:

Question:
${question}

Resolved temporal references:
${formatTemporalReferences(retrieval.temporalReferences)}

Semantic retrieval hints:
${formatSemanticHints(retrieval.semanticPlan, { hintsVersion })}

Resolved master-data candidates:
${formatMasterDataCandidates(masterDataCandidates)}

Retrieval relevance hint (a ranking only; every allowed table may be used):
${relevanceHint}

Few-shot examples:
${examples}`;
}

const MAX_HINT_COLUMNS_PER_TABLE = 4;

// Columns of `table` whose name or comment shares a token with the question,
// most shared tokens first, ignoring the table's own name tokens ("customer"
// says nothing about which Customer column matters) and primary keys.
function questionMatchedColumns(table, questionTokens) {
  const tableTokens = new Set(normalizeTokens(table.name));
  const tokens = questionTokens.filter((token) => !tableTokens.has(token));
  if (tokens.length === 0) {
    return [];
  }
  return table.columns
    .filter((column) => !column.primaryKey)
    .map((column, index) => {
      const columnTokens = new Set([...normalizeTokens(column.name), ...normalizeTokens(column.comment || '')]);
      return { name: column.name, index, matches: tokens.filter((token) => columnTokens.has(token)).length };
    })
    .filter((entry) => entry.matches > 0)
    .sort((left, right) => right.matches - left.matches || left.index - right.index)
    .slice(0, MAX_HINT_COLUMNS_PER_TABLE)
    .map((entry) => entry.name);
}

/**
 * The tables retrieval ranked for the question, as shown to people (web debug
 * panel, CLI, eval records): the picked tables in score order (strongest match
 * first, the order of the full scope's relevance hint), then the join-path
 * connectors retrieval added. Empty when nothing matched the question:
 * retrieval then falls back to a default selection, which is not a ranking
 * (the prompt's hint says no table matched).
 */
export function rankedTableNames(retrieval) {
  if (!retrieval || retrieval.fallbackToDefaultSelection) {
    return [];
  }
  // initialTableNames holds schema names; report physical table names, as the
  // allow-list and the relevance hint do.
  const tableNameOf = new Map((retrieval.tableScores || []).map((entry) => [entry.name, entry.tableName || entry.name]));
  const ranked = uniqueStrings((retrieval.initialTableNames || []).map((name) => tableNameOf.get(name) || name));
  const connectors = uniqueStrings(retrieval.connectorTableNames || []).filter((name) => !ranked.includes(name));
  return [...ranked, ...connectors];
}

/**
 * The full scope's relevance hint: the tables retrieval ranked highest (score
 * order, then the join-path connectors it added) with the columns whose names
 * match the question. Returns { text, tables: [{ tableName, columns, connector }] }.
 */
export function buildRelevanceHint(schema, retrieval) {
  if (retrieval.fallbackToDefaultSelection) {
    return {
      text: '- No table matched the wording of this question; choose tables from the schema above.',
      tables: [],
    };
  }
  const byName = new Map(schema.tables.map((table) => [table.name, table]));
  const byTableName = new Map(schema.tables.map((table) => [table.tableName, table]));
  const ranked = uniqueStrings(retrieval.initialTableNames)
    .map((name) => byName.get(name) || byTableName.get(name))
    .filter(Boolean);
  const rankedNames = new Set(ranked.map((table) => table.tableName));
  const connectors = uniqueStrings(retrieval.connectorTableNames)
    .map((name) => byTableName.get(name) || byName.get(name))
    .filter((table) => table && !rankedNames.has(table.tableName));
  const tables = [
    ...ranked.map((table) => ({ tableName: table.tableName, columns: questionMatchedColumns(table, retrieval.questionTokens), connector: false })),
    ...connectors.map((table) => ({ tableName: table.tableName, columns: [], connector: true })),
  ];
  const format = (entry) => (entry.columns.length > 0 ? `${entry.tableName} (${entry.columns.join(', ')})` : entry.tableName);
  const rankedText = tables.filter((entry) => !entry.connector).map(format).join('; ');
  const connectorText = connectors.length > 0 ? `; join path via ${connectors.map((table) => table.tableName).join(', ')}` : '';
  return {
    text: `- Most relevant tables/columns for this question: ${rankedText || 'none'}${connectorText}`,
    tables,
  };
}

function buildLegacyOptimizedCacheablePrefix() {
  return `You are a senior SQL analyst writing MariaDB 10.6 SQL for a retail/distribution demo system.

Write one read-only SQL query using only the provided schema context.
Use only in-scope foreign keys and in-scope tables.
${EXACT_SCHEMA_GUARD}

`;
}

function summarizePromptCacheLayout({ system, schemaContext, questionContext, effectiveScope = 'retrieved' }) {
  const staticSystemChars = system.length;
  const schemaPrefixChars = system.length + schemaContext.length;
  const dynamicChars = questionContext.length;
  const totalChars = system.length + schemaContext.length + questionContext.length;
  const legacyCacheablePrefix = buildLegacyOptimizedCacheablePrefix();
  const legacyCacheablePrefixChars = legacyCacheablePrefix.length;
  const systemEstimatedTokens = estimatePromptTokens(system);
  const schemaEstimatedTokens = estimatePromptTokens(schemaContext);
  const questionEstimatedTokens = estimatePromptTokens(questionContext);
  const legacyCacheablePrefixEstimatedTokens = estimatePromptTokens(legacyCacheablePrefix);

  return {
    strategy: 'static-system-and-schema-prefix',
    messageLayout: [
      { role: 'system', cacheBehavior: 'globally_stable_instructions' },
      {
        role: 'user',
        cacheBehavior:
          effectiveScope === 'full'
            ? 'globally_stable_schema_prefix_then_question_context'
            : 'table_stable_schema_prefix_then_question_context',
      },
    ],
    staticSystemChars,
    staticSystemEstimatedTokens: systemEstimatedTokens,
    cacheablePrefixChars: schemaPrefixChars,
    cacheablePrefixEstimatedTokens: systemEstimatedTokens + schemaEstimatedTokens,
    dynamicChars,
    dynamicEstimatedTokens: questionEstimatedTokens,
    totalChars,
    totalEstimatedTokens: systemEstimatedTokens + schemaEstimatedTokens + questionEstimatedTokens,
    legacyCacheablePrefixChars,
    legacyCacheablePrefixEstimatedTokens,
    additionalCacheablePrefixEstimatedTokens:
      systemEstimatedTokens + schemaEstimatedTokens - legacyCacheablePrefixEstimatedTokens,
  };
}

// The full in-scope schema block (stable: no question tokens), per schema
// object. It is both the full scope's cacheable prefix and what 'auto'
// measures against SCHEMA_FULL_MAX_TOKENS.
const fullSchemaContextCache = new WeakMap();

function fullSchemaStableContext(schema) {
  const key = schema.tables;
  let entry = fullSchemaContextCache.get(key);
  if (!entry) {
    const stableContext = buildPromptContext(schema.tables, []);
    const schemaContext = buildOptimizedSchemaContext(stableContext);
    entry = { stableContext, schemaContext, estimatedTokens: estimatePromptTokens(schemaContext) };
    fullSchemaContextCache.set(key, entry);
  }
  return entry;
}

/** Estimated tokens (characters / 4) of the full in-scope schema block. */
export function estimateFullSchemaTokens(schema) {
  return fullSchemaStableContext(schema).estimatedTokens;
}

/**
 * The schema scope in effect for `schema` (src/schema-scope.js):
 * { requested, effective: 'retrieved' | 'full', fullSchemaEstimatedTokens,
 * fullSchemaMaxTokens, widenOnDemand, inScopeTableCount }. 'auto' is 'full'
 * when the full schema block fits fullSchemaMaxTokens, else 'retrieved'.
 * `option` is a scope name or a (partial) config; omitted means the defaults
 * (auto, 8000 tokens, widen-on-demand on), not the environment.
 */
export function resolveEffectiveSchemaScope(schema, option = undefined) {
  const config = normalizeSchemaScopeConfig(option);
  const fullSchemaEstimatedTokens = estimateFullSchemaTokens(schema);
  const effective =
    config.schemaScope === 'auto'
      ? fullSchemaEstimatedTokens <= config.fullSchemaMaxTokens
        ? 'full'
        : 'retrieved'
      : config.schemaScope;
  return {
    requested: config.schemaScope,
    effective,
    fullSchemaEstimatedTokens,
    fullSchemaMaxTokens: config.fullSchemaMaxTokens,
    widenOnDemand: config.widenOnDemand,
    inScopeTableCount: schema.tables.length,
  };
}

// Retrieved scope, widen-on-demand: the retrieved tables plus `extraTables`
// (in-scope table names) and the connector tables on the shortest foreign-key
// path from each added table to the retrieved ones. Unknown or already
// retrieved names are ignored. Null when nothing is added.
function widenRetrievedTables(schema, retrievedTables, extraTables) {
  const byTableName = new Map(schema.tables.map((table) => [table.tableName, table]));
  const current = new Set(retrievedTables.map((table) => table.name));
  const added = uniqueStrings(extraTables)
    .map((tableName) => byTableName.get(tableName))
    .filter((table) => table && !current.has(table.name))
    .map((table) => table.name);
  if (added.length === 0) {
    return null;
  }
  const { adjacency } = buildForeignKeyGraph(schema.tables);
  const expanded = new Set([...current, ...added]);
  const connectors = new Set();
  for (const addedName of added) {
    for (const currentName of current) {
      for (const pathName of findShortestJoinPath(adjacency, addedName, currentName) || []) {
        if (!expanded.has(pathName)) {
          connectors.add(pathName);
        }
        expanded.add(pathName);
      }
    }
  }
  const tableNameOf = (name) => schema.tables.find((table) => table.name === name)?.tableName || name;
  return {
    tables: schema.tables.filter((table) => expanded.has(table.name)),
    addedTableNames: added.map(tableNameOf),
    connectorTableNames: [...connectors].map(tableNameOf),
  };
}

/**
 * In-scope tables to add to a retrieved-scope prompt after `rejection` (a
 * validation error or a { code, layer, table } verdict) of `sql`: when the
 * safety layer rejected an IN-SCOPE table as outside the allow-list
 * (TABLE_SCOPE), every in-scope table the SQL references that is not allowed
 * yet. Anything else (another code, a table outside the in-scope schema, a
 * metadata schema or another database) yields [] and stays rejected.
 */
export function tablesToWidenFor(rejection, sql, { schema, allowedTables = [] }) {
  if (rejection?.code !== 'TABLE_SCOPE' || rejection.layer !== 'safety') {
    return [];
  }
  const inScope = new Set(schema.tables.map((table) => table.tableName));
  const rejected = rejection.table ?? rejection.details?.table ?? null;
  if (!inScope.has(rejected)) {
    return [];
  }
  const allowed = new Set(allowedTables);
  return uniqueStrings([rejected, ...extractTablesFromSql(sql)]).filter((name) => inScope.has(name) && !allowed.has(name));
}

/**
 * The hints version a prompt is built with: the explicit option, else the
 * version the semantic plan was built with (a version-2 plan is marked; an
 * unmarked plan is a version-1 plan or a hand-built one), else the default.
 * A version-2 plan in a version-1 prompt is a caller bug and throws.
 */
function resolvePromptHintsVersion(hintsVersion, semanticPlan) {
  if (hintsVersion === undefined || hintsVersion === null) {
    return normalizeHintsVersion(semanticPlan ? semanticPlan.hintsVersion ?? 1 : undefined);
  }
  const version = normalizeHintsVersion(hintsVersion);
  if (semanticPlan?.hintsVersion !== undefined && semanticPlan.hintsVersion !== version) {
    throw new Error(`The semantic plan was built with hints version ${semanticPlan.hintsVersion}, the prompt asks for ${version}.`);
  }
  return version;
}

/**
 * The optimized prompt for `question`. Options:
 * - masterDataCandidates, semanticPlan: question context resolved upstream;
 * - schemaScope: a scope name or config (src/schema-scope.js; default auto).
 *   'full' shows every in-scope table in one stable block and allows them
 *   all; 'retrieved' shows and allows the retrieved tables (the prompt every
 *   question had before schema scopes existed, byte for byte);
 * - extraTables: retrieved scope only, in-scope tables to add (widen-on-demand
 *   after a TABLE_SCOPE rejection; see tablesToWidenFor);
 * - hintsVersion: 1 or 2 (src/hints-version.js; default: the plan's, else 2).
 *   Version 1 is the prompt every question had before HINTS_VERSION existed,
 *   byte for byte.
 * `tables` is the allow-list; `context.schemaScope` says which scope applied
 * and `context.hintsVersion` which hints version.
 */
export function buildOptimizedPrompt(
  schema,
  question,
  { masterDataCandidates = [], semanticPlan = null, schemaScope = undefined, extraTables = [], hintsVersion = undefined } = {}
) {
  const scope = resolveEffectiveSchemaScope(schema, schemaScope);
  const version = resolvePromptHintsVersion(hintsVersion, semanticPlan);
  const retrieval = retrieveRelevantTables(schema, question, { semanticPlan, hintsVersion: version });
  if (scope.effective === 'full') {
    return buildFullScopePrompt(schema, question, { retrieval, scope, masterDataCandidates, hintsVersion: version });
  }
  const widened = extraTables.length > 0 ? widenRetrievedTables(schema, retrieval.tables, extraTables) : null;
  const promptTables = widened ? widened.tables : retrieval.tables;
  const context = buildPromptContext(promptTables, retrieval.questionTokens);
  const stableContext = buildPromptContext(promptTables, []);
  const relevantExamples = retrieveRelevantExamples(question, {
    maxExamples: 2,
    minScore: 1,
  });
  const examples = formatExamples(relevantExamples);
  const system = buildOptimizedSystemPrompt({ hintsVersion: version });
  const schemaContext = buildOptimizedSchemaContext(stableContext);
  const questionContext = buildOptimizedQuestionContext({
    question,
    retrieval,
    rankedContext: context,
    masterDataCandidates,
    examples,
    hintsVersion: version,
  });
  const promptCache = summarizePromptCacheLayout({
    system,
    schemaContext,
    questionContext,
  });

  return {
    system,
    user: `${schemaContext}\n\n${questionContext}`,
    tables: promptTables,
    context: {
      ...context,
      normalizedQuestion: retrieval.normalizedQuestion,
      temporalReferences: retrieval.temporalReferences,
      retrieval: {
        initialTableNames: retrieval.initialTableNames,
        expandedTableNames: retrieval.expandedTableNames,
        connectorTableNames: retrieval.connectorTableNames,
        fallbackToDefaultSelection: retrieval.fallbackToDefaultSelection,
        tableScores: retrieval.tableScores,
      },
      semanticPlan: retrieval.semanticPlan,
      masterDataCandidates,
      promptCache,
      schemaScope: {
        ...scope,
        widenedTables: widened ? widened.addedTableNames : [],
        widenConnectorTables: widened ? widened.connectorTableNames : [],
      },
      hintsVersion: version,
      examples: summarizeExamples(relevantExamples),
    },
  };
}

function summarizeExamples(examples) {
  return examples.map((example) => ({
    question: example.question,
    tables: example.tables,
    score: example.score,
    matchedTokens: example.matchedTokens,
  }));
}

// Full scope: every in-scope table in one stable schema block (the cacheable
// prefix, identical for every question), retrieval as a one-line hint, and
// every in-scope table allowed.
function buildFullScopePrompt(schema, question, { retrieval, scope, masterDataCandidates, hintsVersion }) {
  const { schemaContext } = fullSchemaStableContext(schema);
  const context = buildPromptContext(schema.tables, retrieval.questionTokens);
  const relevanceHint = buildRelevanceHint(schema, retrieval);
  const relevantExamples = retrieveRelevantExamples(question, { maxExamples: 2, minScore: 1 });
  const system = buildOptimizedSystemPrompt({ effectiveScope: 'full', hintsVersion });
  const questionContext = buildFullScopeQuestionContext({
    question,
    retrieval,
    relevanceHint: relevanceHint.text,
    masterDataCandidates,
    examples: formatExamples(relevantExamples),
    hintsVersion,
  });
  const promptCache = summarizePromptCacheLayout({ system, schemaContext, questionContext, effectiveScope: 'full' });

  return {
    system,
    user: `${schemaContext}\n\n${questionContext}`,
    tables: schema.tables,
    context: {
      ...context,
      normalizedQuestion: retrieval.normalizedQuestion,
      temporalReferences: retrieval.temporalReferences,
      retrieval: {
        initialTableNames: retrieval.initialTableNames,
        expandedTableNames: retrieval.expandedTableNames,
        connectorTableNames: retrieval.connectorTableNames,
        fallbackToDefaultSelection: retrieval.fallbackToDefaultSelection,
        tableScores: retrieval.tableScores,
      },
      relevanceHint: relevanceHint.tables,
      semanticPlan: retrieval.semanticPlan,
      masterDataCandidates,
      promptCache,
      schemaScope: { ...scope, widenedTables: [], widenConnectorTables: [] },
      hintsVersion,
      examples: summarizeExamples(relevantExamples),
    },
  };
}

export function cleanModelOutput(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json|sql)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractMessageText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }

        return part?.text || '';
      })
      .join('');
  }

  return '';
}

export const BASIC_MODEL_REQUEST_OPTIONS = {
  temperature: 0,
  max_completion_tokens: 1200,
};

// Typed failure for a completion that must not be parsed: the model hit the
// token limit (finish_reason 'length', so the SQL/JSON is cut off) or declined
// to answer (finish_reason 'content_filter', or a structured-output refusal).
// Parsing partial output would execute a truncated query or a refusal string,
// so callers get error.code 'LLM_TRUNCATED' / 'LLM_REFUSED' (stage 'llm')
// instead. usage/cost ride along because those tokens were still billed.
export class LlmResponseError extends Error {
  constructor(message, { code, finishReason = null, refusal = null, rawText = '', usage = null, cost = null, responseId = null, responseModel = null } = {}) {
    super(message);
    this.name = 'LlmResponseError';
    this.code = code;
    this.stage = 'llm';
    this.finishReason = finishReason;
    this.refusal = refusal;
    this.rawText = rawText;
    this.usage = usage;
    this.cost = cost;
    this.responseId = responseId;
    this.responseModel = responseModel;
  }
}

function assertCompleteChoice(choice, details) {
  const finishReason = choice?.finish_reason || null;
  if (finishReason === 'length') {
    throw new LlmResponseError(
      'The model response was cut off at the completion token limit (finish_reason=length); the partial output was discarded.',
      { ...details, code: 'LLM_TRUNCATED', finishReason }
    );
  }

  const refusal = typeof choice?.message?.refusal === 'string' && choice.message.refusal ? choice.message.refusal : null;
  if (finishReason === 'content_filter' || refusal) {
    throw new LlmResponseError(
      finishReason === 'content_filter'
        ? 'The model response was blocked by the provider content filter (finish_reason=content_filter).'
        : `The model declined to answer: ${refusal}`,
      { ...details, code: 'LLM_REFUSED', finishReason, refusal }
    );
  }
}

export async function generateBasicSql({ client, model, prompt }) {
  const request = {
    model,
    ...BASIC_MODEL_REQUEST_OPTIONS,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
  };
  const tracedRequest = {
    ...request,
    messages: request.messages.map((message) => ({ ...message })),
  };

  const response = await client.chat.completions.create(request);
  const rawText = extractMessageText(response.choices[0]?.message?.content);
  const usage = response.usage || null;
  const responseModel = response.model || model;

  assertCompleteChoice(response.choices[0], {
    rawText,
    usage,
    cost: calculateCost(responseModel, usage),
    responseId: response.id || null,
    responseModel,
  });

  return {
    sql: cleanModelOutput(rawText),
    rawText,
    usage,
    cost: calculateCost(responseModel, usage),
    finishReason: response.choices[0]?.finish_reason || null,
    responseId: response.id || null,
    responseModel,
    request: tracedRequest,
  };
}

export const OPTIMIZED_MODEL_REQUEST_OPTIONS = {
  temperature: 0,
  max_completion_tokens: 3200,
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'text_to_sql_response',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['sql', 'explanation', 'tables_used', 'assumptions'],
        properties: {
          sql: { type: 'string' },
          explanation: { type: 'string' },
          tables_used: {
            type: 'array',
            items: { type: 'string' },
          },
          assumptions: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
  },
};

export async function generateOptimizedResponse({ client, model, prompt, retryContext = null, signal = null }) {
  const messages = [{ role: 'system', content: prompt.system }];

  if (!retryContext) {
    messages.push({ role: 'user', content: prompt.user });
  } else {
    messages.push({ role: 'user', content: prompt.user });
    messages.push({
      role: 'assistant',
      content: JSON.stringify({
        sql: retryContext.sql,
        explanation: 'Previous attempt',
        tables_used: retryContext.tablesUsed || [],
        assumptions: retryContext.assumptions || [],
      }),
    });
    // Phrase the corrective hint by the stage that actually failed. A validation
    // rejection is not a "database error", and saying so misdirects the model's
    // fix. Unknown/execution stages keep the original wording. After
    // widen-on-demand ('schema_widened') the rejected table is in the schema
    // context of this retry, so the model must not be told to avoid it.
    const failureLabel =
      retryContext.stage === 'validation'
        ? 'was rejected by SQL validation (guardrails) with this error'
        : retryContext.stage === 'schema_widened'
          ? 'used a table that was missing from the schema context; the schema context above has been widened'
          : retryContext.stage === 'llm'
            ? 'could not be generated; the previous attempt failed with this error'
            : 'failed with this database error';
    messages.push({
      role: 'user',
      content: `The SQL above ${failureLabel}:\n${retryContext.error}\n\nReturn corrected JSON only.`,
    });
  }

  const request = {
    model,
    ...OPTIMIZED_MODEL_REQUEST_OPTIONS,
    messages,
  };
  const tracedRequest = {
    ...request,
    messages: request.messages.map((message) => ({ ...message })),
  };

  // Pass the abort signal so a disconnected client (SSE closed) stops the
  // in-flight generation instead of burning the full completion's tokens. The
  // SDK only checks it per HTTP attempt: its retry backoff sleep (retry-after
  // is honoured up to 60 s) ignores it, so the wait is bounded here as well;
  // the SDK's own late rejection is then ignored.
  const response = await untilAborted(client.chat.completions.create(request, signal ? { signal } : undefined), signal, {
    abortError: () => new APIUserAbortError(),
  });
  const rawText = extractMessageText(response.choices[0]?.message?.content);
  const usage = response.usage || null;
  const responseModel = response.model || model;

  // A truncated or refused completion is a typed failure, never parsed below.
  assertCompleteChoice(response.choices[0], {
    rawText,
    usage,
    cost: calculateCost(responseModel, usage),
    responseId: response.id || null,
    responseModel,
  });

  const cleaned = cleanModelOutput(rawText);

  try {
    const parsed = JSON.parse(cleaned);
    return {
      sql: cleanModelOutput(parsed.sql || ''),
      explanation: parsed.explanation || '',
      tables_used: Array.isArray(parsed.tables_used) ? parsed.tables_used : [],
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
      rawText,
      usage,
      cost: calculateCost(responseModel, usage),
      finishReason: response.choices[0]?.finish_reason || null,
      responseId: response.id || null,
      responseModel,
      request: tracedRequest,
    };
  } catch {
    return {
      sql: cleaned,
      explanation: 'Model response was not valid JSON.',
      tables_used: [],
      assumptions: ['Response parsing failed; SQL was extracted from raw output.'],
      rawText,
      usage,
      cost: calculateCost(responseModel, usage),
      finishReason: response.choices[0]?.finish_reason || null,
      responseId: response.id || null,
      responseModel,
      request: tracedRequest,
    };
  }
}

// Strip string literals, quoted identifiers, and comments using the shared
// MariaDB tokenizer. Kept for diagnostics and callers that want a literal-free
// view of the SQL; the safety layer itself works on tokens.
export function stripSqlForSafetyScan(sql) {
  return stripSqlTokens(tokenizeSql(String(sql || ''), { tolerant: true }), { blankQuotedIdentifiers: true });
}

function safetyError(code, message, details = null) {
  return new SqlValidationError(message, { code, layer: 'safety', details });
}

// Layer-1 policy over significant tokens. Keywords are matched on bare word
// tokens only (never inside strings or quoted identifiers, and never on an
// identifier that directly follows `ident.`); function names are matched on bare
// and backtick-quoted identifiers followed by '('.
// The validator is intentionally conservative: the first keyword must already be
// SELECT/WITH and only a single statement is permitted, so these lists target
// the residual ways a SELECT can still write, exfiltrate, lock, or stall.
const WRITE_KEYWORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'REPLACE',
  'MERGE',
  'GRANT',
  'REVOKE',
  'CALL',
  'DO',
  'HANDLER',
  'RENAME',
  'PREPARE',
  'EXECUTE',
  'DEALLOCATE',
  'SHUTDOWN',
  'KILL',
  'FLUSH',
  'INSTALL',
  'UNINSTALL',
  'LOAD',
]);

// String functions that share a name with a write statement: REPLACE(str, a, b)
// and INSERT(str, pos, len, new) are read-only when called as functions.
const WRITE_KEYWORD_STRING_FUNCTIONS = new Set(['REPLACE', 'INSERT']);

const RESTRICTED_FUNCTIONS = new Set([
  // timing / denial of service
  'SLEEP',
  'BENCHMARK',
  // locking
  'GET_LOCK',
  'RELEASE_LOCK',
  'RELEASE_ALL_LOCKS',
  'IS_FREE_LOCK',
  'IS_USED_LOCK',
  // file access
  'LOAD_FILE',
  // replication waits (block until a position/GTID or the timeout)
  'MASTER_POS_WAIT',
  'MASTER_GTID_WAIT',
  'WAIT_FOR_EXECUTED_GTID_SET',
  // error-based / XML exfiltration
  'NAME_CONST',
  'EXTRACTVALUE',
  'UPDATEXML',
  // sequence state changes (MariaDB 10.3+) and session state
  'NEXTVAL',
  'SETVAL',
  'LASTVAL',
  'LAST_INSERT_ID',
]);

const SESSION_INFO_FUNCTIONS = new Set([
  'USER',
  'CURRENT_USER',
  'SESSION_USER',
  'SYSTEM_USER',
  'VERSION',
  'DATABASE',
  'SCHEMA',
  'CONNECTION_ID',
  'CURRENT_ROLE',
]);

// MariaDB also accepts these without parentheses (SELECT CURRENT_USER).
const BARE_SESSION_INFO_KEYWORDS = new Set(['CURRENT_USER', 'CURRENT_ROLE']);

const METADATA_SCHEMAS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);
// Unambiguous schema names are rejected anywhere; mysql/sys only when used as a
// qualifier (`mysql.user`) so a column alias named "sys" stays legal.
const ALWAYS_METADATA_SCHEMAS = new Set(['information_schema', 'performance_schema']);

const SAFETY_MESSAGES = {
  NOT_READ_ONLY: 'Only read-only SQL is allowed.',
  FILE_OUTPUT: 'Writing query output to files is not allowed.',
  SELECT_INTO: 'SELECT ... INTO (variables or files) is not allowed.',
  SERVER_VARIABLE: 'User-defined and server (@/@@) variables are not allowed.',
  METADATA_SCHEMA: 'Querying server metadata schemas is not allowed.',
  DENYLISTED_FUNCTION:
    'Use of restricted SQL functions (locking, file, timing, replication, sequence, or XML) is not allowed.',
  SESSION_INFO_FUNCTION: 'Server/session information functions are not allowed.',
  PROCEDURE_CLAUSE: 'PROCEDURE clauses are not allowed.',
  RECURSIVE_CTE: 'Recursive CTEs (WITH RECURSIVE) are not allowed.',
  INDEX_HINT: 'Index hints (USE/FORCE/IGNORE INDEX or KEY) are not allowed.',
  SYSTEM_TIME: 'System-versioned table queries (FOR SYSTEM_TIME) are not allowed.',
  CROSS_DATABASE: 'Cross-database references (db.table or db.function()) are not allowed.',
};

function isPunctToken(token, value) {
  return Boolean(token) && token.type === 'punct' && token.value === value;
}

function isCallToken(tokens, index) {
  return isPunctToken(tokens[index + 1], '(');
}

function lowerIdentifier(token) {
  if (token?.type === 'quoted_identifier') {
    return token.name.toLowerCase();
  }
  return token?.type === 'word' ? token.value.toLowerCase() : null;
}

// Returns the first layer-1 violation among the significant tokens, scanning in
// order so the reported error is the leftmost offending construct.
function findTokenPolicyViolation(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];

    if (token.type === 'variable') {
      return ['SERVER_VARIABLE'];
    }

    const lower = lowerIdentifier(token);
    if (lower && METADATA_SCHEMAS.has(lower) && (ALWAYS_METADATA_SCHEMAS.has(lower) || isPunctToken(next, '.'))) {
      return ['METADATA_SCHEMA'];
    }

    const isIdentifier = (token.type === 'word' && !token.afterDot) || token.type === 'quoted_identifier';
    if (!isIdentifier) {
      continue;
    }
    if (isPunctToken(next, '.') && tokens[index + 2] && isCallToken(tokens, index + 2)) {
      // db.function(...) calls a stored function in another schema.
      return ['CROSS_DATABASE'];
    }
    if (isCallToken(tokens, index)) {
      // MariaDB resolves a backtick-quoted built-in name too: `SLEEP`(5) and
      // `LOAD_FILE`('/etc/passwd') run the real functions (verified on 10.6).
      const functionName = token.type === 'quoted_identifier' ? token.name.toUpperCase() : token.upper;
      if (RESTRICTED_FUNCTIONS.has(functionName)) {
        return ['DENYLISTED_FUNCTION'];
      }
      if (SESSION_INFO_FUNCTIONS.has(functionName)) {
        return ['SESSION_INFO_FUNCTION'];
      }
    }

    if (token.type !== 'word') {
      continue;
    }

    const word = token.upper;
    if (word === 'FOR' && isKeywordToken(next, 'UPDATE', 'SHARE')) {
      return ['LOCKING_READ', `Locking reads (FOR ${next.upper}) are not allowed.`];
    }
    // Index hints and FOR SYSTEM_TIME sit inside a FROM list and may be followed
    // by `, another_table`. Generated analytics SQL never needs them, so they are
    // rejected outright instead of being parsed (USE, FORCE and IGNORE are
    // reserved, so `USE INDEX` cannot be an alias followed by a column).
    if ((word === 'USE' || word === 'FORCE' || word === 'IGNORE') && isKeywordToken(next, 'INDEX', 'KEY')) {
      return ['INDEX_HINT'];
    }
    if (word === 'FOR' && isKeywordToken(next, 'SYSTEM_TIME')) {
      return ['SYSTEM_TIME'];
    }
    if (word === 'LOCK') {
      return ['LOCKING_READ', 'Locking reads (LOCK IN SHARE MODE) are not allowed.'];
    }
    if (word === 'INTO') {
      return isKeywordToken(next, 'OUTFILE', 'DUMPFILE') ? ['FILE_OUTPUT'] : ['SELECT_INTO'];
    }
    if (word === 'SET' && !isKeywordToken(tokens[index - 1], 'CHARACTER')) {
      // Only CHARACTER SET is legal inside a read query; SET STATEMENT etc. is not.
      return ['NOT_READ_ONLY'];
    }
    if (WRITE_KEYWORDS.has(word) && !(WRITE_KEYWORD_STRING_FUNCTIONS.has(word) && isCallToken(tokens, index))) {
      return ['NOT_READ_ONLY'];
    }
    if (word === 'PROCEDURE') {
      return ['PROCEDURE_CLAUSE'];
    }
    if (word === 'WITH' && isKeywordToken(next, 'RECURSIVE')) {
      return ['RECURSIVE_CTE'];
    }
    if ((word === 'NEXT' || word === 'PREVIOUS') && isKeywordToken(next, 'VALUE') && isKeywordToken(tokens[index + 2], 'FOR')) {
      return ['DENYLISTED_FUNCTION'];
    }
    if (BARE_SESSION_INFO_KEYWORDS.has(word)) {
      return ['SESSION_INFO_FUNCTION'];
    }
  }

  return null;
}

/**
 * Layer 1: read-only safety and table scope, computed from MariaDB-faithful
 * tokens. Rejects (with error.code and error.layer = 'safety'):
 * - any comment and any executable comment (generated analytics SQL never needs
 *   comments, and comment-lexing differences are how payloads hide),
 * - unterminated strings/identifiers/comments, control characters, and
 *   backslash-escaped quotes (ambiguous under NO_BACKSLASH_ESCAPES),
 * - write/DDL keywords, SELECT ... INTO, locking reads, PROCEDURE, SET,
 *   @/@@ variables, restricted and session-information functions, sequences,
 *   WITH RECURSIVE, index hints, FOR SYSTEM_TIME, metadata schemas and
 *   cross-database references,
 * - anything but a single SELECT/WITH statement (one trailing ';' is allowed;
 *   the statement may open with parentheses, as in `(SELECT ...) UNION (...)`),
 * - table references outside `allowedTables`, including parenthesized table
 *   references and table functions after FROM/JOIN (fail closed). CTE names are
 *   query-local and are not checked, but the tables inside CTE bodies are.
 */
export function validateSqlSafety(sql, allowedTables = []) {
  const cleaned = cleanModelOutput(sql);
  if (cleaned.includes('\u0000')) {
    throw safetyError('INVALID_CHARACTER', 'SQL contains a NUL character.');
  }

  let tokens;
  try {
    tokens = tokenizeSql(cleaned);
  } catch (error) {
    if (error instanceof SqlTokenizeError) {
      throw safetyError(error.code, error.message, { position: error.position, tokenType: error.tokenType });
    }
    throw error;
  }

  if (tokens.some((token) => token.type === 'executable_comment')) {
    throw safetyError('EXECUTABLE_COMMENT', 'Executable SQL comments (/*! ... */ and /*M! ... */) are not allowed.');
  }
  if (tokens.some((token) => token.type === 'comment')) {
    throw safetyError('SQL_COMMENT', 'SQL comments (--, # and /* */) are not allowed in generated SQL.');
  }
  const unknown = tokens.find((token) => token.type === 'unknown');
  if (unknown) {
    throw safetyError('INVALID_CHARACTER', `SQL contains an unexpected control character at offset ${unknown.start}.`);
  }
  if (tokens.some((token) => token.type === 'string' && token.backslashEscapedQuote)) {
    throw safetyError(
      'AMBIGUOUS_STRING_ESCAPE',
      "Escape quotes inside string literals by doubling them ('') instead of using a backslash."
    );
  }

  const analysis = analyzeSqlStructure(tokens);
  const significant = analysis.tokens;

  // A single trailing ';' is allowed and stripped from the executed SQL.
  let statementTokens = significant;
  let executableSql = cleaned;
  if (isPunctToken(significant.at(-1), ';')) {
    statementTokens = significant.slice(0, -1);
    executableSql = cleaned.slice(0, significant.at(-1).start).trimEnd();
  }
  if (statementTokens.length === 0) {
    throw safetyError('EMPTY_SQL', 'Model did not return SQL.');
  }

  const violation = findTokenPolicyViolation(statementTokens);
  if (violation) {
    const [code, message] = violation;
    throw safetyError(code, message || SAFETY_MESSAGES[code]);
  }

  // A query expression may open with parentheses: `(SELECT ...) UNION (SELECT
  // ...)` and `((SELECT ...))` are plain reads, so skip leading '(' tokens.
  let headIndex = 0;
  while (isPunctToken(statementTokens[headIndex], '(')) {
    headIndex += 1;
  }
  const firstKeyword = isKeywordToken(statementTokens[headIndex], 'SELECT', 'WITH') ? statementTokens[headIndex].upper : null;
  if (!firstKeyword) {
    throw safetyError('NOT_SELECT', 'Only SELECT or WITH queries are allowed.');
  }

  if (statementTokens.some((token) => isPunctToken(token, ';'))) {
    throw safetyError('MULTI_STATEMENT', 'Only a single SQL statement is allowed.');
  }

  const [issue] = analysis.issues;
  if (issue) {
    throw safetyError(issue.code, issue.message);
  }

  for (const ref of analysis.tableRefs) {
    if (ref.kind === 'table' && ref.schema) {
      const code = METADATA_SCHEMAS.has(ref.schema.toLowerCase()) ? 'METADATA_SCHEMA' : 'CROSS_DATABASE';
      throw safetyError(code, SAFETY_MESSAGES[code]);
    }
  }

  const tablesUsed = [
    ...new Set(analysis.tableRefs.filter((ref) => ref.kind === 'table').map((ref) => ref.name)),
  ];
  const allowSet = new Set(allowedTables || []);
  for (const tableName of tablesUsed) {
    if (!allowSet.has(tableName)) {
      throw safetyError('TABLE_SCOPE', `SQL references table "${tableName}" which is outside the allowed table set.`, {
        table: tableName,
      });
    }
  }

  return {
    sql: executableSql,
    tablesUsed,
    statementCount: 1,
    firstKeyword,
    cteNames: [...new Set(analysis.ctes.map((cte) => cte.name))],
  };
}

/**
 * Full validation: layer 1 (validateSqlSafety) then layer 2 (schema-aware
 * guardrails, only when a prompt context is supplied). Every rejection is a
 * SqlValidationError carrying `code` and `layer`.
 */
export function validateReadOnlySql(sql, allowedTables, { promptContext = null, response = null } = {}) {
  const safety = validateSqlSafety(sql, allowedTables);
  const guardrails = validateSqlGuardrails(safety.sql, {
    allowedTables,
    promptContext,
    response,
    tablesUsed: safety.tablesUsed,
  });

  return {
    sql: safety.sql,
    tablesUsed: safety.tablesUsed,
    statementCount: safety.statementCount,
    firstKeyword: safety.firstKeyword,
    guardrails,
  };
}

// --- Execution bounds -------------------------------------------------------
// The generated SQL is model-authored, so a pathological join could otherwise
// run unbounded and pin the MariaDB instance, which may also host sensitive
// non-demo databases. Every path (web, CLI, benchmark, master-data lookups) is
// bounded by default: QUERY_STATEMENT_TIMEOUT_MS (default 8000; 0 disables).
export const DEFAULT_STATEMENT_TIMEOUT_MS = 8000;

function configError(message) {
  const error = new Error(message);
  error.code = 'INVALID_CONFIG';
  return error;
}

function readIntegerEnv(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }

  // Plain decimal digits only (Number() would also take "0x50" or "8e3").
  const text = String(raw).trim();
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw configError(`${name} must be an integer between ${min} and ${max}; got "${raw}".`);
  }

  return value;
}

export function resolveStatementTimeoutMs(env = process.env) {
  return readIntegerEnv(env, 'QUERY_STATEMENT_TIMEOUT_MS', DEFAULT_STATEMENT_TIMEOUT_MS, { min: 0 });
}

// MariaDB's `SET STATEMENT var=value[, ...] FOR <stmt>` scopes session variables
// to this one statement:
// - max_statement_time (seconds, fractional allowed) bounds the execution tail.
// - sql_select_limit caps the rows the server returns WITHOUT rewriting the
//   query: it applies only to the outermost SELECT (subqueries, derived tables,
//   CTEs and window frames still see every row) and keeps ORDER BY. Verified on
//   MariaDB 10.6. An explicit LIMIT in the query takes precedence over it, so
//   executeReadOnlySql also stops reading after maxRows rows (see readRows).
export function buildBoundedStatement(sql, { timeoutMs = 0, maxRows = null } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError(`timeoutMs must be a non-negative number of milliseconds; got ${timeoutMs}.`);
  }

  if (maxRows != null && (!Number.isInteger(maxRows) || maxRows < 1)) {
    throw new TypeError(`maxRows must be a positive integer; got ${maxRows}.`);
  }

  const settings = [];
  if (timeoutMs > 0) {
    // Never round a tiny positive timeout down to 0, which would disable it.
    settings.push(`max_statement_time=${(Math.max(timeoutMs, 1) / 1000).toFixed(3)}`);
  }
  if (maxRows != null) {
    settings.push(`sql_select_limit=${maxRows}`);
  }

  return settings.length > 0 ? `SET STATEMENT ${settings.join(', ')} FOR ${sql}` : sql;
}

function createQueryAbortError(signal, cause = null) {
  const reason = signal?.reason;
  const error = new Error('The database query was cancelled because the request was aborted.');
  error.name = 'AbortError';
  error.code = typeof reason?.code === 'string' ? reason.code : 'QUERY_ABORTED';
  error.cause = cause || reason || null;
  return error;
}

// Settles like `promise`, unless `signal` aborts first: then it rejects at once
// with `abortError()` (default: the signal's reason). A value that still
// arrives after the abort is handed to `onLate`, so a resource nobody will use
// (a pool connection, a runtime lease) is released instead of leaked; a late
// rejection is ignored. Without a signal it simply awaits `promise`.
export function untilAborted(promise, signal, { onLate = null, abortError = () => signal.reason } = {}) {
  if (!signal) {
    return Promise.resolve(promise);
  }
  return new Promise((resolve, reject) => {
    let abandoned = false;
    const onAbort = () => {
      abandoned = true;
      reject(abortError());
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (!abandoned) {
          resolve(value);
          return;
        }
        try {
          onLate?.(value);
        } catch {
          // Best-effort cleanup of a result nobody is waiting for.
        }
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        if (!abandoned) {
          reject(error);
        }
      }
    );
  });
}

// How long to wait for an in-flight KILL QUERY before giving up on returning the
// connection to the pool (it is destroyed instead, see below).
const KILL_SETTLE_TIMEOUT_MS = 2000;

// Resolves with `promise`'s value, or with 'timeout' if it takes longer.
function waitForSettle(promise, timeoutMs) {
  let timer;
  // Not unref'd: the connection must be released or destroyed before the
  // process exits.
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Reads one statement's rows. Without maxRows (or on a connection without the
// mysql2 core API, e.g. a test fake) it is a plain buffered query.
//
// With maxRows, rows arrive as a stream through the mysql2 core connection and
// at most maxRows are kept. sql_select_limit already caps the result, but an
// explicit LIMIT in model SQL overrides it (`... LIMIT 100000000` would still
// pull the whole table into Node), so the read itself is bounded too: when row
// maxRows + 1 arrives the promise resolves with `overflowed: true` and every
// later row is dropped as it is parsed, never materialized. A pool caller then
// destroys the connection to stop the transfer (see executeOnPoolConnection);
// a single connection keeps draining (and discarding) in the background, so its
// next statement simply queues behind this one.
function readRows(connection, statement, params, { maxRows = null } = {}) {
  const core = connection?.connection;
  if (maxRows == null || typeof core?.query !== 'function') {
    const pending = params === undefined ? connection.query(statement) : connection.query(statement, params);
    return Promise.resolve(pending).then(([rows]) => {
      if (maxRows != null && Array.isArray(rows) && rows.length > maxRows) {
        return { rows: rows.slice(0, maxRows), overflowed: true, streamed: false };
      }
      return { rows, overflowed: false, streamed: false };
    });
  }

  return new Promise((resolve, reject) => {
    const rows = [];
    let settled = false;
    // mysql2 reports a fatal error of a callback-less command (a dropped or
    // killed connection, mid-read or before the command was even sent) on the
    // core connection, never on the query: without these listeners the read
    // would never settle and the process could drain its event loop and exit
    // as if nothing had happened.
    const watchesConnection = typeof core.on === 'function' && typeof core.removeListener === 'function';
    const onConnectionError = (error) => fail(error || connectionLostError());
    const onConnectionEnd = () => fail(connectionLostError());
    const stopWatching = () => {
      if (watchesConnection) {
        core.removeListener('error', onConnectionError);
        core.removeListener('end', onConnectionEnd);
      }
    };
    const succeed = (value) => {
      if (!settled) {
        settled = true;
        stopWatching();
        resolve(value);
      }
    };
    function fail(error) {
      if (!settled) {
        settled = true;
        stopWatching();
        reject(error);
      }
    }

    const deadError = closedConnectionError(core);
    if (deadError) {
      fail(deadError);
      return;
    }
    if (watchesConnection) {
      core.on('error', onConnectionError);
      core.on('end', onConnectionEnd);
    }

    let query;
    try {
      query = params === undefined ? core.query(statement) : core.query(statement, params);
    } catch (error) {
      fail(error);
      return;
    }
    query.on('result', (row) => {
      if (settled) {
        return; // past the cap (or failed): drop it
      }
      if (rows.length < maxRows) {
        rows.push(row);
        return;
      }
      succeed({ rows, overflowed: true, streamed: true });
    });
    // Always listened to, even after settling: an unhandled 'error' event on
    // the query would crash the process.
    query.on('error', (error) => fail(error));
    query.on('end', () => succeed({ rows, overflowed: false, streamed: true }));
  });
}

function connectionLostError(message = 'Connection lost: the database connection closed during the query.') {
  const error = new Error(message);
  error.code = 'PROTOCOL_CONNECTION_LOST';
  error.fatal = true;
  return error;
}

// The error a mysql2 core connection already carries (or a generic connection
// loss when it is closing or its socket is gone), or null when it is usable.
function closedConnectionError(core) {
  const fatal = core._fatalError || core._protocolError;
  if (fatal) {
    return fatal;
  }
  if (core._closing || core.stream?.destroyed) {
    return connectionLostError("Can't add new command when connection is in closed state");
  }
  return null;
}

// KILL QUERY for a cancelled request. Pools from createMariaDbPool provide
// killQuery(), which uses its own short-lived connection: a pool slot could be
// queued behind the very queries it should stop when the pool is saturated.
function killQuery(pool, threadId) {
  return typeof pool.killQuery === 'function' ? pool.killQuery(threadId) : pool.query(`KILL QUERY ${threadId}`);
}

// Runs a statement on a dedicated pool connection, which makes it
// - killable: if the signal aborts mid-query, `KILL QUERY <threadId>` is sent
//   (MariaDB lets a user kill its own threads without extra privileges). The
//   killed statement fails with ER_QUERY_INTERRUPTED and its connection stays
//   usable.
// - row-capped: when the server sends more than maxRows rows (an explicit
//   LIMIT in the SQL), the statement is killed and the connection dropped
//   instead of drained; the pool opens a fresh one when needed. (Dropping alone
//   is not enough: mysql2's destroy() only half-closes the socket, and MariaDB
//   keeps producing rows into it until the statement ends.)
//
// Every wait is bounded by the signal: on a saturated pool the request gives up
// waiting for a slot when it aborts (a connection handed out later goes
// straight back), and the read itself is not awaited past the abort, because a
// KILL that fails or is slow leaves the statement running (indefinitely when
// the statement timeout is off). Rows are never returned after an abort.
async function executeOnPoolConnection(pool, statement, params, { signal, maxRows, killSettleTimeoutMs }) {
  const abortError = () => createQueryAbortError(signal);
  const connection = await untilAborted(pool.getConnection(), signal, {
    onLate: (late) => late.release(),
    abortError,
  });
  let killPromise = null;
  let overflowed = false;

  const startKill = () => {
    const threadId = Number(connection.threadId);
    if (!killPromise && Number.isInteger(threadId) && threadId > 0) {
      killPromise = Promise.resolve()
        .then(() => killQuery(pool, threadId))
        .catch(() => null);
    }
  };
  const onAbort = () => startKill();

  if (signal?.aborted) {
    connection.release();
    throw createQueryAbortError(signal);
  }

  // Registered before the read is raced against the signal, so the KILL is
  // already on its way when the caller is answered.
  signal?.addEventListener('abort', onAbort, { once: true });
  let reading = null;
  try {
    reading = readRows(connection, statement, params, { maxRows });
    const result = await untilAborted(reading, signal, { abortError });
    overflowed = result.overflowed && result.streamed;
    if (signal?.aborted) {
      // Finished in the same turn as the abort: the request is cancelled.
      throw abortError();
    }
    return result.rows;
  } catch (error) {
    if (signal?.aborted && error?.name !== 'AbortError') {
      throw createQueryAbortError(signal, error);
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (overflowed) {
      // The server is still sending rows nobody will read. Never reuse this
      // thread, and stop the statement; the caller does not wait for the KILL
      // (thread ids are not reused, so a late KILL cannot hit another query).
      connection.destroy();
      startKill();
    } else if (!killPromise) {
      connection.release();
    } else {
      // Cancelled. The caller is answered now; the thread goes back to the pool
      // only once the KILL has landed (or failed) AND the statement has ended
      // while we still own it, so neither can hit the next query on it.
      // Otherwise it is dropped. A streamed read that overflows the cap after
      // the abort has NOT ended (readRows resolves on row maxRows + 1 while the
      // server keeps sending, e.g. because the KILL failed): it is dropped at
      // once, like an overflow before the abort.
      const statement = reading
        ? reading.then((late) => (late.overflowed && late.streamed ? 'overflow' : 'ended'), () => 'ended')
        : Promise.resolve('ended');
      const outcome = statement.then((state) => (state === 'overflow' ? state : killPromise.then(() => state)));
      void waitForSettle(outcome, killSettleTimeoutMs).then((state) =>
        state === 'ended' ? connection.release() : connection.destroy()
      );
    }
  }
}

// Executes model-authored, already-validated SQL with server-side bounds.
// - timeoutMs: per-statement max_statement_time. Omitted/null uses
//   QUERY_STATEMENT_TIMEOUT_MS (default 8000); 0 disables.
// - maxRows: at most this many rows are returned: sql_select_limit caps the
//   result server-side, and the read stops after maxRows rows when an explicit
//   LIMIT overrides it. Callers that display N rows pass N + 1 so truncation is
//   detectable without fetching more.
// - signal: when it aborts during execution on a pool, the query is killed.
// - params: optional placeholders (client-side escaped by mysql2), used by the
//   parameterized master-data lookups.
// - killSettleTimeoutMs: how long to wait for an issued KILL QUERY (tests).
export async function executeReadOnlySql(
  connection,
  sql,
  { timeoutMs = null, maxRows = null, signal = null, params = undefined, killSettleTimeoutMs = KILL_SETTLE_TIMEOUT_MS } = {}
) {
  const effectiveTimeoutMs = timeoutMs == null ? resolveStatementTimeoutMs() : timeoutMs;
  const statement = buildBoundedStatement(sql, { timeoutMs: effectiveTimeoutMs, maxRows });

  if (signal?.aborted) {
    throw createQueryAbortError(signal);
  }

  // Pools run the statement on a dedicated connection whenever it must be
  // killable or row-capped; a plain pool.query() could do neither.
  if (typeof connection.getConnection === 'function' && (signal || maxRows != null)) {
    return executeOnPoolConnection(connection, statement, params, { signal, maxRows, killSettleTimeoutMs });
  }

  const { rows } = await untilAborted(readRows(connection, statement, params, { maxRows }), signal, {
    abortError: () => createQueryAbortError(signal),
  });
  return rows;
}

export function printRows(rows, output = console) {
  if (!Array.isArray(rows) || rows.length === 0) {
    output.log('  (no rows)');
    return;
  }

  output.table(rows);
}

export function compareRows(expectedRows, actualRows) {
  if (expectedRows.length !== actualRows.length) {
    return false;
  }

  const normalizeRow = (row) => {
    const normalized = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[key.toLowerCase()] =
        typeof value === 'number' ? Math.round(value * 1000) / 1000 : value;
    }
    return JSON.stringify(normalized);
  };

  const expected = expectedRows.map(normalizeRow).sort();
  const actual = actualRows.map(normalizeRow).sort();
  return expected.every((value, index) => value === actual[index]);
}

// Explicit transport bounds for the OpenAI SDK. Its defaults (10-minute timeout,
// 2 retries) let one question run for over an hour against a hung provider, and
// the app's own self-correction loop multiplies that. OPENAI_TIMEOUT_MS (default
// 60000) bounds each HTTP attempt; OPENAI_MAX_RETRIES (default 1) bounds
// transport retries (connection errors, 408/409/429/5xx) inside one app attempt.
export const DEFAULT_OPENAI_TIMEOUT_MS = 60_000;
export const DEFAULT_OPENAI_MAX_RETRIES = 1;

export function resolveOpenAiClientOptions({ timeoutMs, maxRetries } = {}, env = process.env) {
  const resolvedTimeoutMs =
    timeoutMs ?? readIntegerEnv(env, 'OPENAI_TIMEOUT_MS', DEFAULT_OPENAI_TIMEOUT_MS, { min: 1, max: 600_000 });
  const resolvedMaxRetries =
    maxRetries ?? readIntegerEnv(env, 'OPENAI_MAX_RETRIES', DEFAULT_OPENAI_MAX_RETRIES, { min: 0, max: 10 });

  if (!Number.isInteger(resolvedTimeoutMs) || resolvedTimeoutMs < 1) {
    throw configError(`OpenAI timeoutMs must be a positive integer; got ${timeoutMs}.`);
  }
  if (!Number.isInteger(resolvedMaxRetries) || resolvedMaxRetries < 0) {
    throw configError(`OpenAI maxRetries must be a non-negative integer; got ${maxRetries}.`);
  }

  return { timeoutMs: resolvedTimeoutMs, maxRetries: resolvedMaxRetries };
}

export function createOpenAiClient({ timeoutMs, maxRetries, env = process.env } = {}) {
  if (!env.OPENAI_API_KEY) {
    const error = new Error('OPENAI_API_KEY is required.');
    error.code = 'OPENAI_NOT_CONFIGURED';
    throw error;
  }

  const options = resolveOpenAiClientOptions({ timeoutMs, maxRetries }, env);
  return new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    ...(env.OPENAI_BASE_URL && { baseURL: env.OPENAI_BASE_URL }),
    timeout: options.timeoutMs,
    maxRetries: options.maxRetries,
  });
}

// --- MariaDB credentials ----------------------------------------------------
// Two roles with separate credentials:
// - 'query' (web, basic, optimized, resolve-master-data, evaluation): DB_USER /
//   DB_PASSWORD, defaulting to the SELECT-only demo_readonly user that
//   docker/mariadb/initdb provisions.
// - 'admin' (bootstrap-db, seed-demo): DB_ADMIN_USER (default root) with the
//   first non-blank of DB_ADMIN_PASSWORD, MARIADB_ROOT_PASSWORD, DB_PASSWORD:
//   the same order docker-compose.yml uses to initialize root's password. When
//   no admin setting is set at all, admin scripts fall back to DB_USER /
//   DB_PASSWORD with a warning, so older single-user (root) setups keep working.
// Blank values count as unset, like compose's `${VAR:-default}`, so template
// lines such as `DB_ADMIN_PASSWORD=` do not override a real setting.
export const DEFAULT_QUERY_DB_USER = 'demo_readonly';
export const DEFAULT_ADMIN_DB_USER = 'root';
const DB_ROLES = new Set(['query', 'admin']);

function nonBlankEnv(env, name) {
  const value = env[name];
  return value === undefined || value === null || String(value).trim() === '' ? undefined : value;
}

export function resolveQueryDbUser(env = process.env) {
  return nonBlankEnv(env, 'DB_USER') || DEFAULT_QUERY_DB_USER;
}

export function resolveMariaDbCredentials({ role = 'query', env = process.env } = {}) {
  if (!DB_ROLES.has(role)) {
    throw new TypeError(`Unknown MariaDB connection role "${role}" (expected "query" or "admin").`);
  }

  if (role === 'query') {
    return {
      role,
      user: resolveQueryDbUser(env),
      password: env.DB_PASSWORD,
      fallback: false,
      credentialVars: 'DB_USER and DB_PASSWORD',
    };
  }

  const adminUser = nonBlankEnv(env, 'DB_ADMIN_USER');
  const adminPassword = nonBlankEnv(env, 'DB_ADMIN_PASSWORD');
  const rootPassword = nonBlankEnv(env, 'MARIADB_ROOT_PASSWORD');
  if (adminUser !== undefined || adminPassword !== undefined || rootPassword !== undefined) {
    return {
      role,
      user: adminUser ?? DEFAULT_ADMIN_DB_USER,
      // Same precedence as root's password in docker-compose.yml.
      password: adminPassword ?? rootPassword ?? nonBlankEnv(env, 'DB_PASSWORD'),
      fallback: false,
      credentialVars: 'DB_ADMIN_USER and DB_ADMIN_PASSWORD (or MARIADB_ROOT_PASSWORD)',
    };
  }

  return {
    role,
    user: nonBlankEnv(env, 'DB_USER'),
    password: env.DB_PASSWORD,
    fallback: true,
    credentialVars: 'DB_USER and DB_PASSWORD',
  };
}

function adminFallbackWarning(user) {
  return (
    `[db] No admin credentials configured (DB_ADMIN_USER / DB_ADMIN_PASSWORD or MARIADB_ROOT_PASSWORD); ` +
    `falling back to DB_USER "${user}" for this admin task. It needs CREATE/INSERT/DELETE privileges, ` +
    'which the read-only query user must not have. Set DB_ADMIN_* to keep the two roles separate.'
  );
}

function buildMariaDbConnectionOptions({ includeDatabase = true, role = 'query', env = process.env } = {}) {
  const credentials = resolveMariaDbCredentials({ role, env });
  const connectionOptions = {
    user: credentials.user,
    password: credentials.password,
    decimalNumbers: true,
  };

  if (includeDatabase) {
    connectionOptions.database = env.DB_NAME;
  }

  if (env.DB_SOCKET) {
    connectionOptions.socketPath = env.DB_SOCKET;
  } else {
    connectionOptions.host = env.DB_HOST || '127.0.0.1';
    connectionOptions.port = Number(env.DB_PORT || 3306);
  }

  return connectionOptions;
}

export function describeMariaDbConnectionTarget({ includeDatabase = true, role = 'query', env = process.env } = {}) {
  const connectionOptions = buildMariaDbConnectionOptions({ includeDatabase, role, env });

  return {
    role,
    user: connectionOptions.user || null,
    database: includeDatabase ? connectionOptions.database || null : null,
    socketPath: connectionOptions.socketPath || null,
    host: connectionOptions.socketPath ? null : connectionOptions.host || null,
    port: connectionOptions.socketPath ? null : connectionOptions.port ?? null,
  };
}

function formatMariaDbTarget(connectionOptions) {
  if (connectionOptions.socketPath) {
    return `socket ${connectionOptions.socketPath}`;
  }

  return `${connectionOptions.host}:${connectionOptions.port}`;
}

function assertMariaDbConfigured({ includeDatabase, role, env }) {
  const credentials = resolveMariaDbCredentials({ role, env });
  const missing = [];
  if (role === 'admin' && credentials.fallback && !credentials.user) {
    missing.push('DB_ADMIN_USER/DB_ADMIN_PASSWORD (or MARIADB_ROOT_PASSWORD, or DB_USER as a fallback)');
  }
  if (includeDatabase && !env.DB_NAME) {
    missing.push('DB_NAME');
  }

  if (missing.length > 0) {
    const error = new Error(
      `Missing required MariaDB env vars: ${missing.join(', ')}. Add them to the loaded .env file or export them in the shell.`
    );
    error.code = 'DB_NOT_CONFIGURED';
    throw error;
  }

  return credentials;
}

// Re-throw driver errors with an actionable message, keeping code/errno so
// callers can still classify them (e.g. connection failures as infra errors).
function wrapConnectionError(error, message) {
  const wrapped = new Error(message, { cause: error });
  wrapped.code = error.code;
  wrapped.errno = error.errno;
  return wrapped;
}

export async function createMariaDbConnection({
  includeDatabase = true,
  role = 'query',
  env = process.env,
  warn = console.warn,
  connect = (options) => mysql.createConnection(options),
} = {}) {
  const credentials = assertMariaDbConfigured({ includeDatabase, role, env });
  if (credentials.fallback) {
    warn(adminFallbackWarning(credentials.user));
  }

  const connectionOptions = buildMariaDbConnectionOptions({ includeDatabase, role, env });

  try {
    return await connect(connectionOptions);
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      throw wrapConnectionError(
        error,
        `Unable to connect to MariaDB at ${formatMariaDbTarget(connectionOptions)}. Start MariaDB locally or update DB_HOST, DB_PORT, or DB_SOCKET.`
      );
    }

    if (error.code === 'ER_BAD_DB_ERROR' && includeDatabase) {
      throw wrapConnectionError(
        error,
        `Database "${env.DB_NAME}" does not exist. Start MariaDB and run "npm run bootstrap-db" first.`
      );
    }

    if (error.code === 'ER_ACCESS_DENIED_ERROR') {
      // The provisioned query user only exists if the init script ran, which
      // happens once, on a fresh data volume (and fails without a password).
      const provisioningHint =
        connectionOptions.user === DEFAULT_QUERY_DB_USER
          ? ` ${DEFAULT_QUERY_DB_USER} is created only when the Docker data volume is first initialized ` +
            '(docker/mariadb/initdb, password from DB_READONLY_PASSWORD or DB_PASSWORD); if it is missing, ' +
            "recreate the volume with 'docker compose down -v'."
          : '';
      throw wrapConnectionError(
        error,
        `MariaDB access denied for user "${connectionOptions.user}". Check ${credentials.credentialVars}.${provisioningHint}`
      );
    }

    if (error.code === 'ER_DBACCESS_DENIED_ERROR' && includeDatabase) {
      throw wrapConnectionError(
        error,
        `MariaDB user "${connectionOptions.user}" may not access database "${env.DB_NAME}". ` +
          'The provisioned query user only has SELECT on demo_retail* databases (docker/mariadb/initdb).'
      );
    }

    throw error;
  }
}

// Connect timeout for the short-lived KILL QUERY connection.
const KILL_CONNECT_TIMEOUT_MS = 5000;

export function createMariaDbPool({ includeDatabase = true, connectionLimit = 5, role = 'query', env = process.env } = {}) {
  assertMariaDbConfigured({ includeDatabase, role, env });

  const connectionOptions = buildMariaDbConnectionOptions({ includeDatabase, role, env });
  const pool = mysql.createPool({
    ...connectionOptions,
    waitForConnections: true,
    connectionLimit,
    queueLimit: 20,
  });

  // Cancelling a request's query must not wait for a free pool slot: when every
  // slot is busy, a pooled KILL would queue behind the very query it should
  // stop. It runs on its own short-lived connection (same user, so it may kill
  // that user's threads).
  pool.killQuery = async (threadId) => {
    const killer = await mysql.createConnection({ ...connectionOptions, connectTimeout: KILL_CONNECT_TIMEOUT_MS });
    try {
      await killer.query(`KILL QUERY ${Number(threadId)}`);
    } finally {
      await killer.end().catch(() => killer.destroy());
    }
  };

  return pool;
}

// The DB grants are the real boundary for model-authored SQL; the validator is
// defense in depth. SHOW GRANTS for the connected (query) user and report
// anything beyond SELECT/USAGE (ALL PRIVILEGES, INSERT, FILE, SUPER, ...),
// grant options, and SELECT that reaches past the expected data: every
// database (*.*), a system schema (mysql.global_priv holds password hashes),
// or (when `database` is given) a database other than DB_NAME and the
// provisioned demo_retail* family. Returns warnings; never throws for an
// unexpected grant format.
const ALLOWED_QUERY_PRIVILEGES = new Set(['SELECT', 'USAGE']);
const SYSTEM_SCHEMAS = ['mysql', 'sys', 'performance_schema', 'information_schema'];
// docker/mariadb/initdb grants SELECT on `demo\_retail%`.*: demo_retail and
// its fixture databases (demo_retail_v2, ...) are always in scope.
const PROVISIONED_DATABASE_PREFIX = 'demo_retail';

function splitPrivileges(list) {
  // Column grants look like "SELECT (a, b)"; drop the column lists first.
  return list
    .replace(/\([^)]*\)/g, '')
    .split(',')
    .map((privilege) => privilege.trim().replace(/\s+/g, ' ').toUpperCase())
    .filter(Boolean);
}

// The database part of a SHOW GRANTS target (`db`.*, `db`.`table`, *.*,
// PROCEDURE `db`.`proc`), unquoted. At database level the name is a LIKE
// pattern (% and _ are wildcards, \ escapes); in a table-level grant it is
// literal. Null for targets that are not db.object (e.g. PROXY grants).
function parseGrantTarget(target) {
  const match = /^(?:(?:PROCEDURE|FUNCTION|PACKAGE BODY|PACKAGE)\s+)?(\*|`(?:[^`]|``)*`|[^.\s`]+)\.(.+)$/i.exec(target.trim());
  if (!match) {
    return null;
  }
  const [, rawDatabase, object] = match;
  const database = rawDatabase.startsWith('`') ? rawDatabase.slice(1, -1).replace(/``/g, '`') : rawDatabase;
  return { database, databaseLevel: object.trim() === '*' };
}

// Splits a grant database name into LIKE tokens: { literal } or { wildcard }.
function grantNameTokens(name, { pattern }) {
  const tokens = [];
  for (let index = 0; index < name.length; index += 1) {
    const char = name[index];
    if (char === '\\' && index + 1 < name.length) {
      index += 1;
      tokens.push({ literal: name[index] });
    } else if (pattern && (char === '%' || char === '_')) {
      tokens.push({ wildcard: char });
    } else {
      tokens.push({ literal: char });
    }
  }
  return tokens;
}

function grantNameMatches(tokens, databaseName) {
  const source = tokens
    .map((token) =>
      token.wildcard ? (token.wildcard === '%' ? '.*' : '.') : token.literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    )
    .join('');
  return new RegExp(`^${source}$`, 'i').test(databaseName);
}

// The text before the first `%`: every database the grant can match starts
// with it (give or take single characters). An unescaped `_` is kept as
// itself here: it stands for exactly one character, so the very common
// `demo_retail`.* still reads as demo_retail rather than "anything".
function grantNamePrefix(tokens) {
  let prefix = '';
  for (const token of tokens) {
    if (token.wildcard === '%') {
      break;
    }
    prefix += token.wildcard || token.literal;
  }
  return prefix;
}

function selectScopeWarning(target, { database }) {
  const parsed = parseGrantTarget(target);
  if (!parsed || parsed.database === '*') {
    return null; // *.* is reported separately
  }

  const tokens = grantNameTokens(parsed.database, { pattern: parsed.databaseLevel });
  const systemSchema = SYSTEM_SCHEMAS.find((schema) => grantNameMatches(tokens, schema));
  if (systemSchema) {
    return `SELECT on ${target} reaches the ${systemSchema} system schema (mysql.global_priv holds password hashes): grant SELECT on the demo database only.`;
  }

  if (!database) {
    return null;
  }
  // In scope: a grant that names DB_NAME itself (a `%` pattern also reaches
  // other databases, e.g. `foo%` reaches foobar), or the provisioned
  // demo_retail* family.
  const hasPercent = tokens.some((token) => token.wildcard === '%');
  const namesDatabase = !hasPercent && grantNameMatches(tokens, database);
  const inScope = namesDatabase || grantNamePrefix(tokens).startsWith(PROVISIONED_DATABASE_PREFIX);
  if (!inScope) {
    const reach = hasPercent ? 'matches databases beyond' : 'is a database other than';
    return `SELECT on ${target} ${reach} DB_NAME (${database}): the query user should only read the configured database.`;
  }
  return null;
}

export function analyzeQueryUserGrants(grants, { database = null } = {}) {
  const warnings = [];
  const privileges = [];

  for (const grant of grants) {
    const text = String(grant || '').trim();
    const onMatch = /^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i.exec(text);
    if (!onMatch) {
      const roleMatch = /^GRANT\s+(.+?)\s+TO\s+/i.exec(text);
      if (roleMatch) {
        warnings.push(`Role ${roleMatch[1]} is granted to the query user; review that role's privileges.`);
      }
      continue;
    }

    const [, privilegeList, target] = onMatch;
    const grantPrivileges = splitPrivileges(privilegeList);
    privileges.push({ on: target, privileges: grantPrivileges });

    const extra = grantPrivileges.filter((privilege) => !ALLOWED_QUERY_PRIVILEGES.has(privilege));
    if (extra.length > 0) {
      warnings.push(`${extra.join(', ')} on ${target}: the query user should only have SELECT (and USAGE).`);
    }

    if (grantPrivileges.includes('SELECT')) {
      if (/^\*\.\*$/.test(target.trim())) {
        warnings.push('SELECT on *.*: the query user can read every database, including the mysql system schema.');
      } else {
        const scopeWarning = selectScopeWarning(target, { database });
        if (scopeWarning) {
          warnings.push(scopeWarning);
        }
      }
    }

    if (/\bWITH\s+GRANT\s+OPTION\b/i.test(text)) {
      warnings.push(`GRANT OPTION on ${target}: the query user can grant its privileges to others.`);
    }
  }

  return { ok: warnings.length === 0, warnings, privileges };
}

function redactGrant(grant) {
  return String(grant || '')
    .replace(/(IDENTIFIED BY PASSWORD\s+)'[^']*'/gi, "$1'<redacted>'")
    .replace(/(\bUSING\s+)'[^']*'/gi, "$1'<redacted>'");
}

// `database` is the configured DB_NAME; SELECT grants on other databases are
// reported (pass null to skip that part of the check).
export async function checkQueryUserPrivileges(connection, { database = process.env.DB_NAME || null } = {}) {
  const [rows] = await connection.query('SHOW GRANTS');
  const grants = (Array.isArray(rows) ? rows : []).map((row) => String(Object.values(row || {})[0] ?? ''));
  return {
    grants: grants.map(redactGrant),
    ...analyzeQueryUserGrants(grants, { database }),
  };
}

// CLI helper: print privilege warnings for the query user to stderr (stdout
// stays clean for results). Best effort: a failed SHOW GRANTS is reported, not
// fatal.
export async function reportQueryUserPrivileges(connection, { log = console.error, database = process.env.DB_NAME || null } = {}) {
  try {
    const report = await checkQueryUserPrivileges(connection, { database });
    for (const warning of report.warnings) {
      log(`[db] warning: ${warning}`);
    }
    return report;
  } catch (error) {
    log(`[db] note: could not check the query user's privileges (${error.message}).`);
    return null;
  }
}

export async function loadNarrowSchema({
  modelsDir,
  schemaPath,
  refreshSchema = false,
  includedTables = DEFAULT_INCLUDED_TABLES,
}) {
  const compiled = await ensureCompiledSchema({
    modelsDir,
    schemaPath,
    force: refreshSchema,
  });

  return filterSchema(compiled, includedTables);
}

export function describeSchema(schema) {
  return {
    generatedAt: schema.generatedAt || null,
    tableCount: schema.tableCount,
    associationErrors: schema.associationErrors || [],
    missingReferencedModels: schema.missingReferencedModels || [],
    tables: schema.tables.map((table) => ({
      name: table.name,
      tableName: table.tableName,
      file: table.file || null,
      description: table.description || null,
      columnCount: table.columns.length,
      foreignKeys: table.foreignKeys.map((foreignKey) => ({
        column: foreignKey.column,
        references: foreignKey.references,
      })),
      ignoredForeignKeys: (table.ignoredForeignKeys || []).map((foreignKey) => ({
        column: foreignKey.column,
        references: foreignKey.references,
      })),
    })),
  };
}

export async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
