export interface ThemeColors {
  prompt: string;
  success: string;
  error: string;
  warning: string;
  info: string;
  dim: string;
  toolName: string;
  timing: string;
  contextBar: string;
  highlight: string;
  lineNumbers: string;
  filePath: string;
  link: string;
  heading: string;
  symbolName: string;
  symbolType: string;
  bracket: string;
}

export interface ThemeIcons {
  success: string;
  failure: string;
  spinner: string;
  inProgress: string;
  pending: string;
  separator: string;
  arrow: string;
  barFill: string;
  barEmpty: string;
  check: string;
  cross: string;
  bullet: string;
  subBullet: string;
  pipe: string;
}

export interface ThemeFormat {
  indent: string;
  indentSize: number;
}

export interface ThemeConfig {
  name: string;
  colors: ThemeColors;
  icons: ThemeIcons;
  format: ThemeFormat;
}
