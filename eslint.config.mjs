// Office ESLint 9 flat config (OFF-001).
// @eslint/js recommended + typescript-eslint recommended, applied to the
// workspace's TypeScript/JavaScript sources. `pnpm lint` runs `eslint .`
// from the repository root.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/build/',
      '**/coverage/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Unused code is an error; underscore-prefixed binders are intentional.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
