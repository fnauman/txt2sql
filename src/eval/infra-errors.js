// Which database failures are the infrastructure's, not the SQL's, for the
// evaluation harness. It extends the product loop's predicate (isInfraError:
// connection/pool/auth codes and mysql2's `fatal` flag) because the harness
// also reads errors that lost both: mysql2's promise API (which the gold
// queries and the master-data lookup go through) copies only code, errno,
// sqlState and sqlMessage onto the error it rejects with, so a query on a
// connection that has died arrives as a bare "Can't add new command when
// connection is in closed state" with no code and no fatal flag.

import { isInfraError } from '../query-service.js';

const EXTRA_INFRA_CODES = new Set(['ER_CONNECTION_KILLED']);
const CLOSED_CONNECTION_MESSAGE = /^(Can't add new command when connection is in closed state|Can't write in closed state)$|^Connection lost\b/;

export function isEvalInfraError(error) {
  if (!error) {
    return false;
  }
  return isInfraError(error) || EXTRA_INFRA_CODES.has(error.code) || (!error.code && CLOSED_CONNECTION_MESSAGE.test(String(error.message || '')));
}
