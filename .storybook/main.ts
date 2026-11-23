import type { StorybookConfig } from "@storybook/html-vite";

export default {
  stories: ["../stories/**/*.stories.ts"],
  framework: {
    name: "@storybook/html-vite",
    options: {},
  },
} satisfies StorybookConfig;
