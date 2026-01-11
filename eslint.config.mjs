import js from '@eslint/js';

export default [
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                // Node.js globals
                console: 'readonly',
                process: 'readonly',
                Buffer: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                module: 'readonly',
                require: 'readonly',
                exports: 'writable',
                setTimeout: 'readonly',
                setInterval: 'readonly',
                clearTimeout: 'readonly',
                clearInterval: 'readonly',
                Date: 'readonly',
                Map: 'readonly',
                Set: 'readonly',
                Promise: 'readonly',
                URL: 'readonly',
                Error: 'readonly',
                encodeURIComponent: 'readonly',
                decodeURIComponent: 'readonly'
            }
        },
        rules: {
            'no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_'
            }],
            'no-console': 'off',
            'semi': ['error', 'always'],
            'quotes': ['error', 'single', { avoidEscape: true }],
            'indent': ['error', 4, { SwitchCase: 1 }],
            'no-trailing-spaces': 'error',
            'eol-last': ['error', 'always'],
            'comma-dangle': ['error', 'never'],
            'no-multiple-empty-lines': ['error', { max: 2 }],
            'space-before-function-paren': ['error', {
                anonymous: 'always',
                named: 'never',
                asyncArrow: 'always'
            }],
            'keyword-spacing': 'error',
            'space-infix-ops': 'error',
            'object-curly-spacing': ['error', 'always'],
            'array-bracket-spacing': ['error', 'never'],
            'no-var': 'error',
            'prefer-const': 'error',
            'no-undef': 'error'
        }
    },
    {
        // Browser environment for client-side scripts
        files: ['public/**/*.js'],
        languageOptions: {
            globals: {
                window: 'readonly',
                document: 'readonly',
                fetch: 'readonly',
                alert: 'readonly',
                WebSocket: 'readonly',
                console: 'readonly',
                setTimeout: 'readonly',
                setInterval: 'readonly',
                clearTimeout: 'readonly',
                clearInterval: 'readonly',
                localStorage: 'readonly',
                Array: 'readonly',
                JSON: 'readonly',
                parseInt: 'readonly',
                encodeURIComponent: 'readonly'
            }
        }
    },
    {
        ignores: [
            'node_modules/**',
            'coverage/**',
            'dist/**',
            '*.min.js',
            'eslint.config.js',
            'eslint.config.mjs'
        ]
    }
];
