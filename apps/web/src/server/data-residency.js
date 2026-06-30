// Decides whether a result's rows may be handed to a CLIENT-SIDE engine
// (arquero in the browser) for zero-round-trip slice/dice.
//
// Shipping rows to the browser is an irreversible data-egress event. The MariaDB
// instance may also host sensitive non-demo databases, so egress is sanctioned
// ONLY for the synthetic demo_retail DB behind the SELECT-only demo_readonly
// user. Default to 'server-only'. This is defense in depth — the DB user/database
// separation remains the real boundary; client-side filtering is presentation,
// never access control. Asserted at emission time, not trusted from the client.
export function resolveDataResidency(env = process.env) {
  const isDemoSource = env.DB_NAME === 'demo_retail' && env.DB_USER === 'demo_readonly';
  return {
    engine: isDemoSource ? 'client-ok' : 'server-only',
    source: `${env.DB_USER || 'unknown'}@${env.DB_NAME || 'unknown'}`,
  };
}
