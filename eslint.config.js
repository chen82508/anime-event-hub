// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** 純函式套件：不得觸碰 DB 與網路（tech-spec §3） */
const PURE_PACKAGES = [
  'packages/core',
  'packages/normalize',
  'packages/tagger',
  'packages/dedup',
  'packages/notify',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      'var/**',
      'packages/db/migrations/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Web Push service worker（瀏覽器端，非 Node）
    files: ['apps/web/public/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    files: PURE_PACKAGES.map((p) => `${p}/src/**/*.ts`),
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@aeh/db', message: '純函式套件不得依賴 DB（tech-spec §3）。' },
            { name: '@aeh/http', message: '純函式套件不得發出網路請求（tech-spec §3）。' },
            { name: '@aeh/scrapers', message: '相依方向：scrapers 依賴本套件，不得反向。' },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@aeh/*'], message: 'core 為最底層，不得依賴其他 @aeh 套件。' }] },
      ],
    },
  },
  prettier,
);
