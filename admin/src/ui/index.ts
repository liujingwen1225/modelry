/**
 * 统一 UI 出口。
 *
 * 业务页面只从 `@/ui` 使用基础 UI：`antd` 的直接引用被 ESLint 限制在 src/ui 与 src/theme。
 * 这里只 re-export Ant Design 的能力，不重写已有基础组件。
 */
export {
  Alert,
  App,
  Avatar,
  Badge,
  Button,
  Checkbox,
  Col,
  Collapse,
  ConfigProvider,
  DatePicker,
  Descriptions,
  Divider,
  Drawer,
  Dropdown,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  List,
  Menu,
  Modal,
  Pagination,
  Popconfirm,
  Popover,
  Progress,
  Radio,
  Result,
  Row,
  Segmented,
  Select,
  Skeleton,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Timeline,
  TimePicker,
  Tooltip,
  Typography,
  Upload,
  theme,
} from 'antd'

export type {
  DescriptionsProps,
  FormProps,
  MenuProps,
  TableColumnsType,
  TableProps,
  TabsProps,
  UploadProps,
} from 'antd'

export { antdTheme } from '@/theme/antd'
export { zhCN } from './locale'
export {
  CodeBlock,
  DetailList,
  ErrorState,
  Field,
  LoadingBlock,
  Meta,
  Mono,
  Notice,
  PageHeader,
  Panel,
  SectionHeading,
  StateBlock,
  StatusTag,
} from './components'
export type { NoticeTone, PageHeaderProps, StatusTone } from './components'
