import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

// 新前端的静态约束：Ant Design 是唯一 UI 组件库，业务页面只经由 @/ui 使用它。
const FORBIDDEN_UI_LIBRARIES = [
  'shadcn',
  '@base-ui/react',
  '@mantine/*',
  '@ant-design/x',
  '@ant-design/x-*',
  '@chakra-ui/*',
  '@mui/*',
  '@radix-ui/*',
  'bootstrap',
  'react-bootstrap',
  'tailwindcss',
  'antd-mobile',
  'semantic-ui-react',
  'primereact',
  '@blueprintjs/*',
]

const NATIVE_CONTROL_SELECTOR =
  'JSXOpeningElement[name.name=/^(button|input|select|textarea|dialog|optgroup|option)$/]'

export default tseslint.config(
  { ignores: ['dist', '../internal/webui/dist', 'node_modules', 'src/api/schema.ts'] },
  {
    // Playwright 驱动脚本运行在 Node 上，不是浏览器代码。
    files: ['e2e/**/*.mjs', '*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-imports': [
        'error',
        { patterns: FORBIDDEN_UI_LIBRARIES.map((pattern) => ({ group: [pattern], message: '新前端只允许 Ant Design 作为 UI 组件库。' })) },
      ],
    },
  },
  {
    // 统一 UI 出口、主题与 locale 以外的代码不得直接引用 antd，也不得使用原生基础交互控件。
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/ui/**', 'src/theme/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...FORBIDDEN_UI_LIBRARIES.map((pattern) => ({ group: [pattern], message: '新前端只允许 Ant Design 作为 UI 组件库。' })),
            {
              group: ['antd', 'antd/*'],
              message: '业务代码必须从 @/ui 使用 Ant Design，不能在页面里直接引用 antd。',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: NATIVE_CONTROL_SELECTOR,
          message: '基础交互控件必须使用 Ant Design 组件（经 @/ui 出口），不能使用原生控件。',
        },
      ],
    },
  },
)
