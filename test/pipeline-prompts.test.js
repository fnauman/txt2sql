import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBasicPrompt, buildOptimizedPrompt } from '../src/pipeline.js';

function createWideTable(tableName, columnCount = 30) {
  return {
    name: tableName,
    tableName,
    description: `${tableName} records`,
    columns: Array.from({ length: columnCount }, (_value, index) => ({
      name: `${tableName}Column${String(index + 1).padStart(2, '0')}`,
      type: 'STRING(50)',
      allowNull: true,
      primaryKey: index === 0,
      references: null,
      comment: null,
    })),
    foreignKeys: [],
  };
}

const wideSchema = {
  tables: [createWideTable('Customer')],
};

function cacheableUserPrefix(prompt) {
  const userPrefixChars = prompt.context.promptCache.cacheablePrefixChars - prompt.system.length;
  return prompt.user.slice(0, userPrefixChars);
}

test('buildBasicPrompt includes exact-name guard without forbidding omitted real columns', () => {
  const prompt = buildBasicPrompt(wideSchema, 'List customers');

  assert.match(prompt.system, /Use only exact table and column names that appear in the schema context below\./);
  assert.match(prompt.system, /Other available columns \(names only\):/);
  assert.match(prompt.system, /CustomerColumn30/);
  assert.doesNotMatch(prompt.system, /do NOT use them/i);
});

test('buildOptimizedPrompt applies the same exact-name guard and omitted column list', () => {
  const prompt = buildOptimizedPrompt(wideSchema, 'List customers');

  assert.match(prompt.system, /Use only exact table and column names that appear in the schema context below\./);
  assert.match(prompt.user, /Other available columns \(names only\):/);
  assert.match(prompt.user, /CustomerColumn30/);
});

test('buildOptimizedPrompt puts schema before volatile question context for caching', () => {
  const prompt = buildOptimizedPrompt(wideSchema, 'List customers');

  assert.ok(prompt.user.indexOf('In-scope schema context:') < prompt.user.indexOf('Question-specific context:'));
  assert.ok(prompt.context.promptCache.cacheablePrefixEstimatedTokens > prompt.context.promptCache.legacyCacheablePrefixEstimatedTokens);
  assert.ok(prompt.context.promptCache.dynamicEstimatedTokens > 0);
});

test('buildOptimizedPrompt keeps question-ranked columns out of cacheable prefix', () => {
  const column20Prompt = buildOptimizedPrompt(wideSchema, 'List CustomerColumn20 customers');
  const column30Prompt = buildOptimizedPrompt(wideSchema, 'List CustomerColumn30 customers');

  assert.equal(cacheableUserPrefix(column20Prompt), cacheableUserPrefix(column30Prompt));
  assert.notEqual(column20Prompt.user, column30Prompt.user);
  assert.match(column30Prompt.user.slice(cacheableUserPrefix(column30Prompt).length), /Question-ranked schema details:/);
  assert.match(column30Prompt.user.slice(cacheableUserPrefix(column30Prompt).length), /CustomerColumn30/);
});
