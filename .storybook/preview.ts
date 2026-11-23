import type { Preview } from "@storybook/html";
import "../src/modules/webui/assets/styles.css";
import "../src/modules/webui/assets/themes.css";

// Токены интерфейса: те же файлы, что подключает index.html (styles.css + themes.css).
// Wave 1 (stories/harness.ts): toolbar тем, en/ru, stubы API/SSE/localStorage.
const preview: Preview = {};

export default preview;
