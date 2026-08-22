import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    /*
     * The WebGL layer.
     *
     * `react-hooks/immutability` assumes React owns every value a component
     * creates. Inside a react-three-fiber render loop that is exactly wrong:
     * a frame callback mutates three.js uniforms, matrices and geometry in
     * place, sixty times a second, precisely so that no React render happens
     * per frame. Following the rule here would mean re-rendering the whole
     * scene graph on every audio sample.
     *
     * The rule stays on everywhere else — including every hook, the HUD and
     * the state layer — so this exemption is the WebGL loop and nothing else.
     */
    files: ['src/three/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/immutability': 'off',
    },
  },
);
