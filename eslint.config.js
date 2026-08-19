import gtsConfig from 'gts/build/eslint.config.js';

/**
 * Google TypeScript Style, as shipped by gts.
 *
 * gts resolves its `project` relative to its own package, so type-aware
 * linting is re-pointed at Conquest's tsconfig here.
 */
export default [
  {ignores: ['build/**', 'coverage/**', 'node_modules/**']},
  ...gtsConfig,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: null,
        projectService: {allowDefaultProject: ['vitest.config.ts']},
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Conquest is an ESM package, so its own flat config is a module.
    files: ['eslint.config.js'],
    languageOptions: {sourceType: 'module'},
  },
];
