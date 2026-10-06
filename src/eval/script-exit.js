// Runs a command-line script's main() so that a run which never settles can
// never report success.
//
// Node exits as soon as its event loop is empty, even when a promise is still
// pending: a database read that never settles (a dropped connection mysql2
// reported somewhere nobody listened) would otherwise end the process with
// exit 0, no verdict and no report. The exit code therefore says failure (2)
// from the start and is replaced only once main() settles.

export const UNSETTLED_EXIT_CODE = 2;

// main() resolves with the exit code (undefined means 0). A rejection gets
// onError(error)'s code (default: print the message, exit 2).
export function runScriptMain(main, { label = 'script', onError = null, output = console } = {}) {
  let settled = false;
  process.exitCode = UNSETTLED_EXIT_CODE;
  const onBeforeExit = () => {
    process.removeListener('beforeExit', onBeforeExit);
    if (!settled) {
      process.exitCode = UNSETTLED_EXIT_CODE;
      output.error(
        `${label}: stopped before finishing: work was still pending with nothing left to run ` +
          `(e.g. a database read that never settled after a dropped connection). Exit ${UNSETTLED_EXIT_CODE}.`
      );
    }
  };
  process.on('beforeExit', onBeforeExit);
  const finish = (code) => {
    settled = true;
    process.removeListener('beforeExit', onBeforeExit);
    process.exitCode = code ?? 0;
  };
  return Promise.resolve()
    .then(() => main())
    .then(finish, (error) => {
      if (onError) {
        finish(onError(error) ?? UNSETTLED_EXIT_CODE);
        return;
      }
      output.error(`${label} failed: ${error?.message || error}`);
      finish(UNSETTLED_EXIT_CODE);
    });
}
