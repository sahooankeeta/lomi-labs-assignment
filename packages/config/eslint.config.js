import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Shared flat config. Apps/packages spread this and add their own bits. */
export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'src/generated/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
