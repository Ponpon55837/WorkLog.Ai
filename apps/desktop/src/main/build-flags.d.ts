/**
 * Constants esbuild substitutes at build time (scripts/build.mjs `define`); they do not exist at run time.
 *
 * - `__WI_TEST_BUILD__`: true in the default (smoke) build, false with `--production`. Everything only a test uses (the
 *   test environment variables, the test hook, the recording switches) sits behind it, so a production bundle does not
 *   contain even their names.
 * - `__WI_BUNDLED_RUNTIME_SHA256__`: hex SHA-256 of the bundled runtime's `runtime-manifest.json` (`--bundled-runtime-sha256`
 *   of a production build, empty in a smoke build).
 */
declare const __WI_TEST_BUILD__: boolean;
declare const __WI_BUNDLED_RUNTIME_SHA256__: string;
