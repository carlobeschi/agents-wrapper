// Lint: catches real mistakes (undefined names, unused variables, unreachable
// code), not style. `npm run lint`; CI runs it with the tests.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // Empty catches are deliberate here (best-effort cleanup, optional files).
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Escape codes are matched on purpose, to strip terminal colours.
      'no-control-regex': 'off',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      // Style only: extra escapes and runs of spaces in regexes are harmless.
      'no-useless-escape': 'off',
      'no-regex-spaces': 'off',
    },
  },
  {
    // Code passed to page.evaluate() runs in the browser.
    files: ['tests/**/*.js', '*card.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
