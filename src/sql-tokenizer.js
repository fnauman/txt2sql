// MariaDB-faithful SQL tokenizer plus a small token-level structure analyzer.
//
// Every deterministic SQL check (the read-only safety layer, allowed-table
// extraction and the schema guardrails) reads model SQL through this one lexer,
// so they all agree on where strings, quoted identifiers and comments begin and
// end. Earlier versions used three different regex "lexers" that disagreed with
// each other and with MariaDB (`1--0` is arithmetic in MariaDB, not a comment),
// which let executable SQL hide from the denylist.
//
// The lexing rules follow MariaDB's sql_lex.cc:
// - '...' and "..." are strings with backslash escapes AND doubled-quote escapes.
// - `...` is a quoted identifier; a doubled backtick is an escaped backtick.
// - `#` starts a comment to the end of the line.
// - `--` starts a comment ONLY when followed by whitespace, a control character
//   or the end of input. Otherwise it is two minus operators (`1--0` = 1 - -0).
// - `/* ... */` is a comment; `/*! ... */` and `/*M! ... */` (optionally with a
//   version number) are executable comments whose body MariaDB runs.
// - Identifier characters are [A-Za-z0-9_$] plus every non-ASCII character, so
//   a non-breaking space or a Cyrillic look-alike is part of an identifier, not
//   whitespace. Whitespace is exactly space, \t, \n, \r, \v and \f.
// - A digit-led run is a number when MariaDB would lex one (`1e5`, `1.`, `0x1F`)
//   and an identifier otherwise (`1abc`, `0x1G`), and `1e5FROM` lexes as the
//   number `1e5` followed by the keyword FROM, exactly like the server.
// - Directly after `ident.` the next identifier run is always an identifier
//   (never a keyword), as in MariaDB's MY_LEX_IDENT_SEP state.

const WHITESPACE_CHARS = new Set([' ', '\t', '\n', '\r', '\v', '\f']);
const PUNCT_CHARS = new Set(['(', ')', ',', ';', '.']);
const OPERATOR_CHARS = new Set(['+', '-', '*', '/', '%', '=', '<', '>', '!', '&', '|', '^', '~', ':', '?', '{', '}', '[', ']', '\\']);
const MULTI_CHAR_OPERATORS = ['<=>', '<=', '>=', '<>', '!=', '<<', '>>', '&&', '||', ':='];

export const SQL_TOKEN_TYPES = Object.freeze([
  'word',
  'quoted_identifier',
  'string',
  'number',
  'variable',
  'operator',
  'punct',
  'comment',
  'executable_comment',
  'whitespace',
  'unknown',
]);

export class SqlTokenizeError extends Error {
  constructor(message, { code = 'UNTERMINATED_TOKEN', tokenType = null, position = null } = {}) {
    super(message);
    this.name = 'SqlTokenizeError';
    this.code = code;
    this.tokenType = tokenType;
    this.position = position;
  }
}

function isDigit(char) {
  return char !== undefined && char >= '0' && char <= '9';
}

function isHexDigit(char) {
  return char !== undefined && /^[0-9A-Fa-f]$/.test(char);
}

// MariaDB's ident_map: ASCII letters, digits, '_', '$' and every multi-byte
// (non-ASCII) character.
export function isSqlIdentifierChar(char) {
  if (char === undefined || char === '') {
    return false;
  }
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    char === '_' ||
    char === '$' ||
    code >= 0x80
  );
}

// `--` is a comment only when the next character is whitespace or a control
// character (my_isspace || my_iscntrl), or when the input ends right there.
function startsDashDashComment(text, index) {
  if (text[index] !== '-' || text[index + 1] !== '-') {
    return false;
  }
  const third = text[index + 2];
  if (third === undefined) {
    return true;
  }
  const code = third.charCodeAt(0);
  return code <= 0x20 || code === 0x7f;
}

function lineCommentEnd(text, index) {
  const newline = text.indexOf('\n', index);
  return newline < 0 ? text.length : newline;
}

// Returns the end index of a valid exponent (`e5`, `E+10`, `e-3`) that starts at
// `index`, or -1 when the characters there do not form one.
function exponentEnd(text, index) {
  if (text[index] !== 'e' && text[index] !== 'E') {
    return -1;
  }
  let cursor = index + 1;
  if (text[cursor] === '+' || text[cursor] === '-') {
    cursor += 1;
  }
  if (!isDigit(text[cursor])) {
    return -1;
  }
  while (isDigit(text[cursor])) {
    cursor += 1;
  }
  return cursor;
}

/**
 * Tokenize SQL the way MariaDB 10.6 does.
 *
 * Returns an array of `{ type, value, start, end }` tokens that covers the
 * input exactly (whitespace and comments included). Extra fields:
 * - word: `upper` (uppercased value), `afterDot` when it directly follows `ident.`
 * - quoted_identifier: `name` (unescaped identifier text)
 * - string: `quote`, `backslashEscapedQuote` when a `\'`-style escape occurs
 *   (such a literal ends at a different place when the server runs with
 *   NO_BACKSLASH_ESCAPES, so the safety layer rejects it)
 * - comment: `style` ('#', '--' or '/*'); executable_comment: `variant`
 *
 * Unterminated strings, quoted identifiers and block comments throw a
 * SqlTokenizeError with code UNTERMINATED_TOKEN so callers fail closed. Pass
 * `{ tolerant: true }` to get a final token flagged `unterminated: true` instead
 * (used only by best-effort helpers over trusted SQL).
 */
export function tokenizeSql(sql, { backslashEscapes = true, tolerant = false } = {}) {
  const text = String(sql ?? '');
  const length = text.length;
  const tokens = [];
  let index = 0;
  let identifierAfterDot = false;

  const push = (type, start, end, extra = {}) => {
    const token = { type, value: text.slice(start, end), start, end, ...extra };
    tokens.push(token);
    return token;
  };

  const unterminated = (type, start, label) => {
    if (!tolerant) {
      throw new SqlTokenizeError(`SQL contains an unterminated ${label} starting at offset ${start}.`, {
        code: 'UNTERMINATED_TOKEN',
        tokenType: type,
        position: start,
      });
    }
    push(type, start, length, { unterminated: true });
    index = length;
  };

  while (index < length) {
    const char = text[index];
    const next = text[index + 1];
    const afterDot = identifierAfterDot;
    identifierAfterDot = false;

    if (WHITESPACE_CHARS.has(char)) {
      let end = index + 1;
      while (end < length && WHITESPACE_CHARS.has(text[end])) {
        end += 1;
      }
      push('whitespace', index, end);
      index = end;
      continue;
    }

    if (char === '#') {
      const end = lineCommentEnd(text, index);
      push('comment', index, end, { style: '#' });
      index = end;
      continue;
    }

    if (startsDashDashComment(text, index)) {
      const end = lineCommentEnd(text, index);
      push('comment', index, end, { style: '--' });
      index = end;
      continue;
    }

    if (char === '/' && next === '*') {
      const executable = text[index + 2] === '!' || (text[index + 2] === 'M' && text[index + 3] === '!');
      const type = executable ? 'executable_comment' : 'comment';
      const close = text.indexOf('*/', index + 2);
      if (close < 0) {
        unterminated(type, index, executable ? 'executable comment' : 'block comment');
        continue;
      }
      push(type, index, close + 2, executable ? { variant: text[index + 2] === 'M' ? 'mariadb' : 'mysql' } : { style: '/*' });
      index = close + 2;
      continue;
    }

    if (char === "'" || char === '"') {
      let cursor = index + 1;
      let closed = false;
      let backslashEscapedQuote = false;
      while (cursor < length) {
        const current = text[cursor];
        if (current === '\\' && backslashEscapes) {
          if (text[cursor + 1] === char) {
            backslashEscapedQuote = true;
          }
          cursor += 2;
          continue;
        }
        if (current === char) {
          if (text[cursor + 1] === char) {
            cursor += 2;
            continue;
          }
          closed = true;
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      if (!closed) {
        unterminated('string', index, 'string literal');
        continue;
      }
      push('string', index, cursor, { quote: char, backslashEscapedQuote });
      index = cursor;
      continue;
    }

    if (char === '`') {
      let cursor = index + 1;
      let closed = false;
      while (cursor < length) {
        if (text[cursor] === '`') {
          if (text[cursor + 1] === '`') {
            cursor += 2;
            continue;
          }
          closed = true;
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      if (!closed) {
        unterminated('quoted_identifier', index, 'quoted identifier');
        continue;
      }
      push('quoted_identifier', index, cursor, {
        name: text.slice(index + 1, cursor - 1).replace(/``/g, '`'),
        afterDot,
      });
      index = cursor;
      continue;
    }

    if (char === '@') {
      // @user_var, @@system_var, @@global.var, @'quoted', @`quoted`. The whole
      // thing is one variable token; a quoted name is lexed with the quote
      // rules above so string boundaries stay in sync with the server.
      let cursor = index + 1;
      if (text[cursor] === '@') {
        cursor += 1;
      }
      const quote = text[cursor];
      if (quote === "'" || quote === '"' || quote === '`') {
        const nested = tokenizeSql(text.slice(cursor), { backslashEscapes, tolerant: true });
        const quoted = nested[0];
        if (!quoted || quoted.unterminated) {
          unterminated('variable', index, 'quoted variable name');
          continue;
        }
        cursor += quoted.end;
      } else {
        while (cursor < length && (isSqlIdentifierChar(text[cursor]) || (text[cursor] === '.' && isSqlIdentifierChar(text[cursor + 1])))) {
          cursor += 1;
        }
      }
      push('variable', index, cursor);
      index = cursor;
      continue;
    }

    if (afterDot && isSqlIdentifierChar(char)) {
      // MY_LEX_IDENT_SEP: after `ident.` the next run is an identifier even if
      // it is a keyword (t.FROM) or starts with a digit (t.1x).
      let end = index + 1;
      while (end < length && isSqlIdentifierChar(text[end])) {
        end += 1;
      }
      push('word', index, end, { upper: text.slice(index, end).toUpperCase(), afterDot: true });
      index = end;
      continue;
    }

    const previousToken = tokens[tokens.length - 1];
    const dotAfterIdentifier =
      char === '.' &&
      Boolean(previousToken) &&
      previousToken.end === index &&
      (previousToken.type === 'word' || previousToken.type === 'quoted_identifier');

    if (isDigit(char) || (char === '.' && isDigit(next) && !dotAfterIdentifier)) {
      let end = index;
      let isNumber = true;

      if (char === '.') {
        end = index + 1;
        while (isDigit(text[end])) {
          end += 1;
        }
        const exponent = exponentEnd(text, end);
        end = exponent > 0 ? exponent : end;
      } else if (char === '0' && (next === 'x' || next === 'b')) {
        const isHex = next === 'x';
        end = index + 2;
        while (end < length && (isHex ? isHexDigit(text[end]) : text[end] === '0' || text[end] === '1')) {
          end += 1;
        }
        if (end - index < 3 || isSqlIdentifierChar(text[end])) {
          isNumber = false;
        }
      } else {
        while (isDigit(text[end])) {
          end += 1;
        }
        const following = text[end];
        if (following === '.') {
          end += 1;
          while (isDigit(text[end])) {
            end += 1;
          }
          const exponent = exponentEnd(text, end);
          end = exponent > 0 ? exponent : end;
        } else if (isSqlIdentifierChar(following)) {
          const exponent = exponentEnd(text, end);
          if (exponent > 0) {
            end = exponent;
          } else {
            isNumber = false;
          }
        }
      }

      if (isNumber) {
        push('number', index, end);
        index = end;
        continue;
      }

      // Digit-led identifier such as `1abc` or `0x1G`.
      end = index;
      while (end < length && isSqlIdentifierChar(text[end])) {
        end += 1;
      }
      push('word', index, end, { upper: text.slice(index, end).toUpperCase(), afterDot: false });
      index = end;
      continue;
    }

    if (isSqlIdentifierChar(char)) {
      let end = index + 1;
      while (end < length && isSqlIdentifierChar(text[end])) {
        end += 1;
      }
      push('word', index, end, { upper: text.slice(index, end).toUpperCase(), afterDot: false });
      index = end;
      continue;
    }

    if (PUNCT_CHARS.has(char)) {
      push('punct', index, index + 1);
      identifierAfterDot = dotAfterIdentifier && isSqlIdentifierChar(next);
      index += 1;
      continue;
    }

    if (OPERATOR_CHARS.has(char)) {
      const operator = MULTI_CHAR_OPERATORS.find((candidate) => text.startsWith(candidate, index)) || char;
      push('operator', index, index + operator.length);
      index += operator.length;
      continue;
    }

    // Control characters (NUL, DEL, ...) are not valid SQL outside literals.
    push('unknown', index, index + 1);
    index += 1;
  }

  return tokens;
}

/**
 * Serialize tokens back to SQL text with literals blanked and comments removed.
 * Comments become a single space so adjacent tokens never glue together
 * (`FROM/**\/t` must not become `FROMt`).
 */
export function stripSqlTokens(tokens, { blankQuotedIdentifiers = false } = {}) {
  return tokens
    .map((token) => {
      if (token.type === 'string') {
        return token.quote + token.quote;
      }
      if (token.type === 'comment' || token.type === 'executable_comment') {
        return ' ';
      }
      if (token.type === 'quoted_identifier' && blankQuotedIdentifiers) {
        return '``';
      }
      return token.value;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Token-level structure analysis
// ---------------------------------------------------------------------------

// Functions whose argument syntax legitimately contains FROM. Inside their
// parentheses FROM is an argument separator, not a table keyword:
// EXTRACT(MONTH FROM d), TRIM(LEADING '0' FROM x), SUBSTRING(x FROM 2 FOR 3).
// Every other FROM is treated as a table keyword (fail closed).
const FROM_ARGUMENT_FUNCTIONS = new Set(['EXTRACT', 'TRIM', 'SUBSTRING', 'SUBSTR', 'MID', 'POSITION', 'OVERLAY']);

// Keywords that end a FROM clause at its own nesting depth. ON/USING are part of
// the clause (a comma after a join condition still introduces another table).
const FROM_CLAUSE_TERMINATORS = new Set([
  'WHERE',
  'GROUP',
  'HAVING',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'FETCH',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'MINUS',
  'WINDOW',
  'FOR',
  'INTO',
  'PROCEDURE',
  'LOCK',
  'RETURNING',
]);

// Words that can follow a table reference without being its alias.
const TABLE_ALIAS_STOPWORDS = new Set([
  ...FROM_CLAUSE_TERMINATORS,
  'AS',
  'ON',
  'USING',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'NATURAL',
  'STRAIGHT_JOIN',
  'OUTER',
  'USE',
  'FORCE',
  'IGNORE',
  'PARTITION',
  'SET',
  'VALUES',
  'SELECT',
  'WITH',
]);

// SELECT options after which STRAIGHT_JOIN is a select modifier, not a join.
const SELECT_OPTION_WORDS = new Set([
  'SELECT',
  'ALL',
  'DISTINCT',
  'DISTINCTROW',
  'HIGH_PRIORITY',
  'SQL_SMALL_RESULT',
  'SQL_BIG_RESULT',
  'SQL_BUFFER_RESULT',
  'SQL_CACHE',
  'SQL_NO_CACHE',
  'SQL_CALC_FOUND_ROWS',
]);

const SET_OPERATORS = new Set(['UNION', 'EXCEPT', 'INTERSECT', 'MINUS']);

export function isKeywordToken(token, ...words) {
  return Boolean(token) && token.type === 'word' && !token.afterDot && words.includes(token.upper);
}

function isPunct(token, value) {
  return Boolean(token) && token.type === 'punct' && token.value === value;
}

function isIdentifierToken(token) {
  return Boolean(token) && ((token.type === 'word' && !token.afterDot) || token.type === 'quoted_identifier');
}

function identifierName(token) {
  if (!token) {
    return null;
  }
  if (token.type === 'quoted_identifier') {
    return token.name;
  }
  return token.type === 'word' ? token.value : null;
}

/**
 * Analyze the significant tokens (no whitespace/comments) of one SQL text:
 * paren groups, SELECT scopes and blocks, CTE declarations and table references.
 *
 * Accepts SQL text or a token array. Never throws for structural problems; they
 * are reported in `issues` (each with a stable `code`) so the strict safety
 * layer can fail closed while best-effort callers can ignore them.
 */
export function analyzeSqlStructure(sqlOrTokens, { tolerant = false } = {}) {
  const allTokens = Array.isArray(sqlOrTokens) ? sqlOrTokens : tokenizeSql(sqlOrTokens, { tolerant });
  const tokens = allTokens
    .filter((token) => token.type !== 'whitespace' && token.type !== 'comment' && token.type !== 'executable_comment')
    .map((token, index) => ({ ...token, index }));
  const issues = [];
  const addIssue = (code, message, index) => {
    issues.push({ code, message, index });
  };

  // Pass 1: paren groups and nesting.
  const groups = [];
  const groupStack = [];
  for (const token of tokens) {
    token.parentGroupId = groupStack.length > 0 ? groupStack[groupStack.length - 1] : null;
    if (isPunct(token, '(')) {
      const previous = tokens[token.index - 1];
      const first = tokens[token.index + 1];
      let kind = 'paren';
      if (isKeywordToken(first, 'SELECT', 'WITH')) {
        kind = 'query';
      } else if (previous && (previous.type === 'word' || previous.type === 'quoted_identifier')) {
        kind = 'call';
      }
      const group = {
        id: groups.length,
        open: token.index,
        close: -1,
        kind,
        callName: kind === 'call' && previous.type === 'word' ? previous.upper : null,
        parentId: token.parentGroupId,
      };
      groups.push(group);
      token.groupId = group.id;
      groupStack.push(group.id);
    } else if (isPunct(token, ')')) {
      const groupId = groupStack.pop();
      if (groupId === undefined) {
        addIssue('UNBALANCED_PARENTHESES', 'SQL has an unmatched closing parenthesis.', token.index);
        token.parentGroupId = null;
        continue;
      }
      groups[groupId].close = token.index;
      token.groupId = groupId;
      token.parentGroupId = groups[groupId].parentId;
    }
  }
  for (const groupId of groupStack) {
    addIssue('UNBALANCED_PARENTHESES', 'SQL has an unclosed parenthesis.', groups[groupId].open);
    groups[groupId].close = tokens.length;
  }

  // Innermost group that contains a token (the paren tokens themselves belong to
  // the enclosing group).
  const innermostGroup = (token) => (token ? token.parentGroupId : null);
  const groupAtOpen = (index) => (isPunct(tokens[index], '(') ? groups[tokens[index].groupId] : null);

  // Pass 2: SELECT scopes (top level + every query group) and set-operator
  // blocks inside each scope.
  const scopeOfGroup = (groupId) => {
    let current = groupId;
    while (current !== null && current !== undefined) {
      if (groups[current].kind === 'query') {
        return current;
      }
      current = groups[current].parentId;
    }
    return 'top';
  };
  const blockCounters = new Map();
  const blocks = new Map();
  for (const token of tokens) {
    const groupId = innermostGroup(token);
    const scopeId = scopeOfGroup(groupId);
    token.scopeId = scopeId;
    const scopeBaseGroup = scopeId === 'top' ? null : scopeId;
    if (isKeywordToken(token, ...SET_OPERATORS) && groupId === scopeBaseGroup) {
      blockCounters.set(scopeId, (blockCounters.get(scopeId) || 0) + 1);
    }
    token.blockId = `${scopeId}:${blockCounters.get(scopeId) || 0}`;
    if (!blocks.has(token.blockId)) {
      blocks.set(token.blockId, { id: token.blockId, scopeId, tokenIndexes: [] });
    }
    blocks.get(token.blockId).tokenIndexes.push(token.index);
  }

  // Pass 3: WITH clauses / CTE declarations. A WITH starts a CTE clause only at
  // the start of a scope (statement start or right after a query paren), which
  // keeps GROUP BY ... WITH ROLLUP out of it.
  const ctes = [];
  const withClauses = [];
  for (const token of tokens) {
    if (!isKeywordToken(token, 'WITH')) {
      continue;
    }
    const previous = tokens[token.index - 1];
    const atScopeStart = token.index === 0 || (isPunct(previous, '(') && groups[previous.groupId]?.kind === 'query');
    if (!atScopeStart) {
      continue;
    }

    const enclosingGroupId = innermostGroup(token);
    const scopeEnd = enclosingGroupId === null ? tokens.length : groups[enclosingGroupId].close;
    let cursor = token.index + 1;
    const recursive = isKeywordToken(tokens[cursor], 'RECURSIVE');
    if (recursive) {
      cursor += 1;
    }
    const clause = { index: token.index, recursive, scopeEnd, cteNames: [] };
    withClauses.push(clause);

    while (cursor < tokens.length) {
      const nameToken = tokens[cursor];
      if (!isIdentifierToken(nameToken)) {
        addIssue('MALFORMED_CTE', 'WITH must be followed by a CTE name.', cursor);
        break;
      }
      const name = identifierName(nameToken);
      cursor += 1;

      let columns = null;
      const columnGroup = groupAtOpen(cursor);
      if (columnGroup) {
        columns = [];
        for (let inner = columnGroup.open + 1; inner < columnGroup.close; inner += 1) {
          const columnToken = tokens[inner];
          if (isIdentifierToken(columnToken)) {
            columns.push(identifierName(columnToken));
          } else if (!isPunct(columnToken, ',')) {
            addIssue('MALFORMED_CTE', `CTE "${name}" has an invalid column list.`, inner);
          }
        }
        cursor = columnGroup.close + 1;
      }

      if (!isKeywordToken(tokens[cursor], 'AS')) {
        addIssue('MALFORMED_CTE', `CTE "${name}" must be declared as: ${name} AS (SELECT ...).`, cursor);
        break;
      }
      cursor += 1;

      const bodyGroup = groupAtOpen(cursor);
      if (!bodyGroup || bodyGroup.kind !== 'query') {
        addIssue('MALFORMED_CTE', `CTE "${name}" must have a parenthesized SELECT body.`, cursor);
        break;
      }

      ctes.push({
        name,
        nameIndex: nameToken.index,
        columns,
        bodyOpen: bodyGroup.open,
        bodyClose: bodyGroup.close,
        recursive,
        // Non-recursive CTEs are visible after their own definition until the
        // end of the statement that owns the WITH clause.
        visibleFrom: recursive ? bodyGroup.open : bodyGroup.close + 1,
        visibleTo: scopeEnd,
        withIndex: token.index,
      });
      clause.cteNames.push(name);
      cursor = bodyGroup.close + 1;

      if (isPunct(tokens[cursor], ',')) {
        cursor += 1;
        continue;
      }
      break;
    }
  }

  // MariaDB compares CTE names case-insensitively (even with
  // lower_case_table_names=0), and a CTE shadows a real table of the same name.
  // Forward references to a later CTE resolve to real tables, which the
  // visibility window above mirrors.
  const resolveCte = (name, index) => {
    const lower = String(name).toLowerCase();
    return (
      ctes.find((cte) => cte.name.toLowerCase() === lower && index >= cte.visibleFrom && index < cte.visibleTo) || null
    );
  };

  // Pass 4: table references after FROM, JOIN/STRAIGHT_JOIN and FROM-list commas.
  const tableRefs = [];
  const parseAlias = (index) => {
    const token = tokens[index];
    if (isKeywordToken(token, 'AS')) {
      const aliasToken = tokens[index + 1];
      return isIdentifierToken(aliasToken) ? { alias: identifierName(aliasToken), end: index + 1 } : { alias: null, end: index };
    }
    if (token?.type === 'quoted_identifier') {
      return { alias: token.name, end: index };
    }
    if (token?.type === 'word' && !token.afterDot && !TABLE_ALIAS_STOPWORDS.has(token.upper)) {
      return { alias: token.value, end: index };
    }
    return { alias: null, end: index - 1 };
  };

  // LEFT/RIGHT/INNER/CROSS/NATURAL before JOIN (skipping OUTER), or null.
  const joinTypeBefore = (keywordIndex) => {
    let cursor = keywordIndex - 1;
    if (isKeywordToken(tokens[cursor], 'OUTER')) {
      cursor -= 1;
    }
    const token = tokens[cursor];
    return isKeywordToken(token, 'LEFT', 'RIGHT', 'INNER', 'CROSS', 'NATURAL', 'FULL') ? token.upper : null;
  };

  const parseTableRef = (index, keywordIndex, via) => {
    const token = tokens[index];
    const base = {
      index,
      keywordIndex,
      via,
      joinType: via === 'JOIN' ? joinTypeBefore(keywordIndex) || 'INNER' : null,
      blockId: tokens[keywordIndex]?.blockId ?? null,
    };

    if (!token || isPunct(token, ';')) {
      addIssue('INVALID_TABLE_REFERENCE', `${via} is not followed by a table name.`, index);
      return;
    }

    if (isPunct(token, '(')) {
      const group = groups[token.groupId];
      if (group.kind !== 'query') {
        addIssue(
          'PARENTHESIZED_TABLE',
          `Parenthesized table references after ${via} are not allowed; use a plain table name or a derived table (SELECT ...).`,
          index
        );
        return;
      }
      const { alias } = parseAlias(group.close + 1);
      tableRefs.push({ ...base, kind: 'derived', name: null, schema: null, alias, open: group.open, close: group.close });
      return;
    }

    if (!isIdentifierToken(token)) {
      addIssue('INVALID_TABLE_REFERENCE', `${via} must be followed by a table name, got "${token.value}".`, index);
      return;
    }

    const name = identifierName(token);
    if (isPunct(tokens[index + 1], '(')) {
      addIssue('TABLE_FUNCTION', `Table functions such as ${name}(...) are not allowed after ${via}.`, index);
      return;
    }
    if (token.type === 'word' && token.upper === 'DUAL') {
      tableRefs.push({ ...base, kind: 'dual', name: 'DUAL', schema: null, alias: null });
      return;
    }

    let end = index;
    let schema = null;
    let tableName = name;
    if (isPunct(tokens[index + 1], '.')) {
      const qualified = tokens[index + 2];
      if (!(qualified && (qualified.type === 'word' || qualified.type === 'quoted_identifier'))) {
        addIssue('INVALID_TABLE_REFERENCE', `Invalid qualified table reference after ${via}.`, index);
        return;
      }
      schema = name;
      tableName = identifierName(qualified);
      end = index + 2;
    }

    const { alias } = parseAlias(end + 1);
    const cte = schema === null ? resolveCte(tableName, index) : null;
    tableRefs.push({
      ...base,
      kind: cte ? 'cte' : 'table',
      name: tableName,
      schema,
      quoted: token.type === 'quoted_identifier',
      alias,
      cteName: cte ? cte.name : null,
    });
  };

  const scanFromClause = (fromIndex) => {
    const fromToken = tokens[fromIndex];
    const groupId = innermostGroup(fromToken);
    for (let cursor = fromIndex + 1; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      if (isPunct(token, '(')) {
        cursor = groups[token.groupId].close;
        continue;
      }
      if (isPunct(token, ')') || isPunct(token, ';')) {
        return;
      }
      if (innermostGroup(token) !== groupId) {
        return;
      }
      if (token.type === 'word' && !token.afterDot && FROM_CLAUSE_TERMINATORS.has(token.upper)) {
        return;
      }
      if (isPunct(token, ',')) {
        parseTableRef(cursor + 1, cursor, 'a comma in the FROM list');
      }
    }
  };

  for (const token of tokens) {
    if (token.type !== 'word' || token.afterDot) {
      continue;
    }
    if (token.upper === 'FROM') {
      const groupId = innermostGroup(token);
      const group = groupId === null ? null : groups[groupId];
      if (group && group.kind === 'call' && FROM_ARGUMENT_FUNCTIONS.has(group.callName)) {
        continue;
      }
      parseTableRef(token.index + 1, token.index, 'FROM');
      scanFromClause(token.index);
      continue;
    }
    if (token.upper === 'JOIN') {
      parseTableRef(token.index + 1, token.index, 'JOIN');
      continue;
    }
    if (token.upper === 'STRAIGHT_JOIN') {
      const previous = tokens[token.index - 1];
      if (previous && previous.type === 'word' && !previous.afterDot && SELECT_OPTION_WORDS.has(previous.upper)) {
        continue;
      }
      parseTableRef(token.index + 1, token.index, 'STRAIGHT_JOIN');
    }
  }

  tableRefs.sort((left, right) => left.index - right.index);

  return {
    tokens,
    groups,
    blocks: [...blocks.values()],
    ctes,
    withClauses,
    tableRefs,
    issues: issues.sort((left, right) => left.index - right.index),
    statementSeparators: tokens.filter((token) => isPunct(token, ';')).map((token) => token.index),
  };
}

/** Text of the significant tokens in [start, end), literals blanked. */
export function tokensToText(tokens, start = 0, end = tokens.length) {
  let text = '';
  let previous = null;
  for (let index = start; index < end; index += 1) {
    const token = tokens[index];
    if (!token) {
      break;
    }
    const value = token.type === 'string' ? token.quote + token.quote : token.value;
    if (previous && previous.end !== token.start) {
      text += ' ';
    }
    text += value;
    previous = token;
  }
  return text;
}
