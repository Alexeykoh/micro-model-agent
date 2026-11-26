import type { Meta, StoryObj } from "@storybook/html-vite";
import { el } from "../src/modules/webui/assets/js/dom.js";

const meta: Meta = {
  title: "smoke",
};
export default meta;

export const SmokeElement: StoryObj = {
  render: () => {
    const node = el("span", "smoke-element", "ok");
    return node;
  },
};
