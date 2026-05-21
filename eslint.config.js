import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default [
  {
    ignores: ['dist/**', 'node_modules/**', '.dist/**', '.dist-cache/**']
  },

  js.configs.recommended,

  {
    languageOptions: {
      globals: globals.node,
      sourceType: 'module'
    }
  },

  ...tseslint.configs.recommended,

  {
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  }
]
