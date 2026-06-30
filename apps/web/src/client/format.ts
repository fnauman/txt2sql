// Pure presentation helpers, kept out of App.tsx so they can be unit-tested
// without a DOM or React renderer.

export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '-';
  }

  if (typeof value === 'number') {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2 }).format(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  return String(value);
}

export function formatCurrency(value?: number, currency = 'USD'): string {
  if (typeof value !== 'number') {
    return '-';
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 6,
  }).format(value);
}

export function csvField(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Map raw backend/exception strings to plain language a non-technical client can
// act on. The raw text is still available in the error banner's "Technical
// details" disclosure and the Debug panel; this only decides the headline.
export function friendlyError(rawMessage: string | null | undefined): string {
  const message = String(rawMessage || '').trim();
  if (!message) {
    return 'Something went wrong while answering that question.';
  }

  const lower = message.toLowerCase();

  if (/missing expected (?:demo|demo_retail|retail)? tables|databaseschemaerror/.test(lower)) {
    return 'The database is not fully set up yet — some demo tables are missing. Ask an administrator to load the data, then try again.';
  }
  if (/failed to fetch|networkerror|econnrefused|fetch failed|load failed|network request failed/.test(lower)) {
    return 'Could not reach the query service. Check that the API server is running, then try again.';
  }
  if (/characters or fewer|question is required/.test(lower)) {
    return message;
  }
  if (/too many requests|rate limit/.test(lower)) {
    return 'Too many requests in a short time. Please wait a moment and try again.';
  }
  if (/unauthorized|forbidden|invalid token|missing token/.test(lower)) {
    return 'You are not authorized to run queries here. Check your access token.';
  }
  if (/only read-only|only select or with|single sql statement|restricted sql functions|are not allowed|executable sql comments/.test(lower)) {
    return 'That question could not be answered with a safe, read-only query. Try rephrasing it.';
  }
  if (
    /outside the allowed table set|unknown column|unknown table|unknown identifier|not an in-scope relationship|preferred column for semantic metric|resolved master-data|tables_used/.test(
      lower
    )
  ) {
    return 'I could not build a valid query for that question against the available tables. Try rephrasing, or turn on Debug to see why.';
  }

  return 'I could not answer that question. Try rephrasing it, or turn on Debug for technical details.';
}
