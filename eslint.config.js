const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
    // Functions are called from inline onclick="..." handlers in the generated HTML.
    rules: { 'no-unused-vars': 'off' },
  },
  {
    // Feature files are separate <script> tags that reuse the globals app.js defines.
    files: ['public/feature-*.js'],
    languageOptions: {
      globals: {
        $: 'readonly', esc: 'readonly', api: 'readonly', send: 'readonly', toast: 'readonly',
        busy: 'readonly', store: 'readonly', state: 'readonly', subjectOf: 'readonly',
        go: 'readonly', refresh: 'readonly', openModal: 'readonly', closeModal: 'readonly',
        addXP: 'readonly', mood: 'readonly', buddySubject: 'readonly', summaryHtml: 'readonly',
        aiNotice: 'readonly', aiSource: 'readonly', readAsBase64: 'readonly',
        wireDrop: 'readonly', UPLOAD_MAX: 'readonly', ymd: 'readonly',
        pad: 'readonly', DAY_SHORT: 'readonly', KINDS: 'readonly', KIND_ICON: 'readonly',
        PALETTE: 'readonly', showBanner: 'readonly', hideBanner: 'readonly',
      },
    },
  },
];
