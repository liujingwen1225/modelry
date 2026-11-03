import type { ThemeConfig } from 'antd'

/**
 * Ant Design 只提供组件行为；外观必须按 Figma 覆盖，不能使用默认主题。
 *
 * 取值与 theme/tokens.css 同源：改颜色、尺寸时两处一起改。
 * Figma「界面控件与状态基线」定义了 34 / 38 / 40 三档控件高度与 4 / 6 / 8 三档圆角。
 */
const fontFamily =
  "'Noto Sans SC', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif"

export const antdTheme: ThemeConfig = {
  token: {
    fontFamily,
    fontSize: 13,
    lineHeight: 1.6,

    colorPrimary: '#385a4b',
    colorLink: '#385a4b',
    colorLinkHover: '#2f4b3e',
    colorSuccess: '#385a4b',
    colorWarning: '#8a6939',
    colorError: '#a45149',
    colorInfo: '#385a4b',

    colorText: '#252b28',
    colorTextHeading: '#252b28',
    colorTextSecondary: '#6d756f',
    colorTextTertiary: '#98a099',
    colorTextQuaternary: '#b3b9b3',
    colorTextPlaceholder: '#98a099',

    colorBgBase: '#ffffff',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    colorBgLayout: '#ffffff',
    colorBgSpotlight: '#252b28',
    colorFillQuaternary: '#f6f7f5',
    colorFillTertiary: '#f6f7f5',
    colorFillSecondary: '#eef0ec',

    colorBorder: '#e6e9e4',
    colorBorderSecondary: '#eef0ec',
    colorSplit: '#e6e9e4',

    borderRadius: 6,
    borderRadiusSM: 4,
    borderRadiusLG: 8,
    borderRadiusXS: 4,

    controlHeight: 34,
    controlHeightSM: 28,
    controlHeightLG: 38,
    controlOutlineWidth: 2,
    controlOutline: 'rgba(56, 90, 75, 0.12)',
    controlItemBgHover: '#f6f7f5',
    controlItemBgActive: '#eaf1eb',

    lineWidth: 1,
    lineWidthBold: 1,

    motionDurationMid: '0.16s',
    motionDurationSlow: '0.22s',

    boxShadow: '0 4px 16px rgba(37, 43, 40, 0.08)',
    boxShadowSecondary: '0 10px 30px rgba(37, 43, 40, 0.12)',
    boxShadowTertiary: '0 1px 2px rgba(37, 43, 40, 0.04)',

    wireframe: false,
  },
  components: {
    Layout: {
      bodyBg: '#ffffff',
      headerBg: '#ffffff',
      siderBg: '#f7f8f6',
      headerHeight: 64,
      headerPadding: '0 28px',
    },
    Menu: {
      itemBg: 'transparent',
      subMenuItemBg: 'transparent',
      itemColor: '#6d756f',
      itemHoverColor: '#252b28',
      itemHoverBg: '#f1f3f0',
      itemSelectedColor: '#385a4b',
      itemSelectedBg: '#eaf1eb',
      itemActiveBg: '#eaf1eb',
      itemHeight: 40,
      itemMarginInline: 0,
      itemMarginBlock: 0,
      itemBorderRadius: 6,
      itemPaddingInline: 12,
      iconSize: 16,
      collapsedIconSize: 16,
      fontSize: 13,
      activeBarWidth: 0,
      activeBarBorderWidth: 0,
      groupTitleColor: '#98a099',
      groupTitleFontSize: 10,
    },
    Button: {
      fontWeight: 500,
      primaryShadow: 'none',
      defaultShadow: 'none',
      dangerShadow: 'none',
      paddingInline: 12,
      paddingInlineSM: 10,
      contentFontSize: 13,
      defaultBorderColor: '#e6e9e4',
      defaultColor: '#252b28',
      defaultHoverBorderColor: '#d3d8d2',
      defaultHoverColor: '#252b28',
      defaultHoverBg: '#f6f7f5',
      defaultBg: '#ffffff',
      textHoverBg: '#f6f7f5',
      colorPrimaryHover: '#2f4b3e',
      colorPrimaryActive: '#294336',
      dangerColor: '#a45149',
    },
    Input: {
      paddingInline: 11,
      paddingBlock: 8,
      activeShadow: 'none',
      hoverBorderColor: '#d3d8d2',
      activeBorderColor: '#385a4b',
      colorBorder: '#e6e9e4',
      fontSize: 13,
    },
    InputNumber: {
      activeShadow: 'none',
      hoverBorderColor: '#d3d8d2',
      activeBorderColor: '#385a4b',
    },
    Select: {
      optionSelectedBg: '#eaf1eb',
      optionActiveBg: '#f6f7f5',
      optionSelectedColor: '#252b28',
      selectorBg: '#ffffff',
    },
    Table: {
      headerBg: '#f6f7f5',
      headerColor: '#6d756f',
      headerSplitColor: 'transparent',
      headerBorderRadius: 0,
      cellPaddingBlock: 10,
      cellPaddingInline: 12,
      rowHoverBg: '#f6f7f5',
      rowSelectedBg: '#eaf1eb',
      rowSelectedHoverBg: '#e3ede5',
      borderColor: '#e6e9e4',
      footerBg: '#ffffff',
    },
    Card: {
      paddingLG: 20,
      headerHeight: 44,
      headerFontSize: 13,
      colorBorderSecondary: '#e6e9e4',
    },
    Tabs: {
      horizontalItemPadding: '12px 0',
      horizontalItemGutter: 27,
      titleFontSize: 13,
      itemColor: '#6d756f',
      itemHoverColor: '#252b28',
      itemSelectedColor: '#385a4b',
      inkBarColor: '#385a4b',
    },
    Modal: {
      titleFontSize: 15,
      paddingContentHorizontalLG: 20,
      contentBg: '#ffffff',
      headerBg: '#ffffff',
    },
    Drawer: {
      paddingLG: 20,
      colorBgElevated: '#ffffff',
      footerPaddingBlock: 16,
      footerPaddingInline: 16,
    },
    Descriptions: {
      labelBg: '#f7f8f6',
      titleMarginBottom: 8,
      itemPaddingBottom: 8,
      colorTextLabel: '#6d756f',
    },
    Tag: {
      defaultBg: '#f6f7f5',
      defaultColor: '#6d756f',
      borderRadiusSM: 4,
    },
    Divider: {
      colorSplit: '#e6e9e4',
      marginLG: 0,
    },
    Form: {
      labelColor: '#252b28',
      labelFontSize: 12,
      verticalLabelPadding: '0 0 7px',
      itemMarginBottom: 16,
    },
    Segmented: {
      itemSelectedBg: '#ffffff',
      itemSelectedColor: '#252b28',
      trackBg: '#f6f7f5',
    },
    Tooltip: {
      colorBgSpotlight: '#252b28',
      borderRadius: 4,
      fontSize: 11,
    },
    Statistic: {
      contentFontSize: 20,
      titleFontSize: 11,
    },
    Empty: {
      colorTextDescription: '#6d756f',
    },
    Message: {
      contentBg: '#ffffff',
    },
    Notification: {
      colorBgElevated: '#ffffff',
    },
    Switch: {
      colorPrimary: '#385a4b',
      handleBg: '#ffffff',
    },
    Checkbox: {
      colorPrimary: '#385a4b',
    },
    Radio: {
      colorPrimary: '#385a4b',
    },
    Pagination: {
      itemBg: '#ffffff',
      itemActiveBg: '#eaf1eb',
    },
    Breadcrumb: {
      itemColor: '#6d756f',
      lastItemColor: '#252b28',
      separatorColor: '#98a099',
      linkColor: '#6d756f',
      linkHoverColor: '#252b28',
      fontSize: 12,
    },
    Upload: {
      colorBorder: '#e6e9e4',
    },
    Progress: {
      defaultColor: '#385a4b',
    },
    Alert: {
      defaultPadding: '12px 16px',
      withDescriptionPadding: '12px 16px',
    },
  },
}
