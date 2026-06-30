// src/result-intelligence.js is shared with the Node pipeline and references the
// Node global `Buffer` (Buffer.isBuffer) during cell normalization. On the client
// the rows are already normalized JSON, so a no-op shim is sufficient — far
// cheaper than pulling in a full Buffer polyfill. Import this BEFORE importing
// result-intelligence on the client.
declare global {
  // eslint-disable-next-line no-var
  var Buffer: { isBuffer: (value: unknown) => boolean } | undefined;
}

if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = { isBuffer: () => false };
}

export {};
