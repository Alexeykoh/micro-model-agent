import * as readline from "readline";
import { pc } from "../ui/colors";
import { t, setLocale } from "../i18n/index";
import { Spinner } from "../ui/spinner";
import { box } from "../ui/box";
import { renderTable } from "../ui/table";

interface SetupAnswers {
  provider: string;
  apiBase: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxToolIterations: number;
  locale: string;
  securityBashBlock: boolean;
  securityFlagsBlock: boolean;
  securityPathsDeny: boolean;
}

async function withSpinner<T>(
  message: string,
  fn: () => Promise<T>,
): Promise<T> {
  const spinner = new Spinner();
  spinner.start(message);
  try {
    return await fn();
  } finally {
    spinner.stop();
  }
}

/** Render a numbered list inside a box. */
function menuList(items: Array<{ label: string; url?: string }>): void {
  const lines = items.map(
    (it, i) =>
      ` ${pc.cyan(`[${i + 1}]`)} ${it.label}${it.url ? `  ${pc.dim(it.url)}` : ""}`,
  );
  for (const l of box(lines, { width: 72 })) console.log(l);
}

function ask(
  rl: readline.Interface,
  question: string,
  defaultValue?: string,
): Promise<string> {
  return new Promise((resolve) => {
    const prompt = defaultValue
      ? `${question} [${defaultValue}]: `
      : `${question}: `;
    rl.question(prompt, (answer: string) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

const PROVIDER_TYPES = [
  {
    value: "openai-compat",
    label: "OpenAI-compatible (LM Studio, Ollama, vLLM, etc.)",
  },
  { value: "openai", label: "OpenAI API" },
  { value: "anthropic", label: "Anthropic Claude" },
];

const KNOWN_PORTS = [
  { port: 1234, label: "LM Studio" },
  { port: 11434, label: "Ollama" },
  { port: 8080, label: "vLLM / custom" },
  { port: 4891, label: "GPT4All" },
];

async function scanPorts(): Promise<{ label: string; url: string }[]> {
  const found: { label: string; url: string }[] = [];
  for (const { port, label } of KNOWN_PORTS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const resp = await fetch(`http://localhost:${port}/v1/models`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (resp.ok) {
        found.push({ label, url: `http://localhost:${port}/v1` });
      }
    } catch {
      /* port not available */
    }
  }
  return found;
}

async function fetchModels(apiBase: string, apiKey: string): Promise<string[]> {
  try {
    const url = `${apiBase.replace(/\/+$/, "")}/models`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return [];
    const data = (await resp.json()) as any;
    const models = (data.data || data || [])
      .map((m: any) => m.id || m.name || m.model || "")
      .filter(Boolean);
    return models;
  } catch {
    return [];
  }
}

async function testChat(
  apiBase: string,
  apiKey: string,
  model: string,
): Promise<boolean> {
  try {
    const url = `${apiBase.replace(/\/+$/, "")}/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: 'Say "ok"' }],
        max_tokens: 20,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return false;
    const data = (await resp.json()) as any;
    const msg = data.choices?.[0]?.message;
    const text = msg?.content || msg?.reasoning_content || "";
    return text.length > 0;
  } catch {
    return false;
  }
}

export async function runSetup(
  externalRl?: readline.Interface,
): Promise<SetupAnswers> {
  console.log(t("setup.title"));

  const rl =
    externalRl ||
    readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  const ownRl = !externalRl;

  console.log(t("setup.language"));
  const locale = await ask(rl, t("setup.ui_lang"), "en");
  setLocale(locale);

  console.log(t("setup.select_provider"));
  menuList(PROVIDER_TYPES);
  const providerChoice = await ask(
    rl,
    t("setup.select_provider_num", { max: PROVIDER_TYPES.length }),
    "1",
  );
  const providerIdx = Math.max(
    0,
    Math.min(PROVIDER_TYPES.length - 1, (parseInt(providerChoice) || 1) - 1),
  );
  const provider = PROVIDER_TYPES[providerIdx].value;

  let apiBase = "";

  if (provider === "openai-compat") {
    const found = await withSpinner(t("setup.scanning_spinner"), async () =>
      scanPorts(),
    );

    if (found.length > 0) {
      console.log(t("setup.found_servers", { count: found.length }));
      menuList([
        ...found.map((f) => ({ label: f.label, url: f.url })),
        { label: t("setup.custom_url") },
      ]);
      const choice = await ask(
        rl,
        t("setup.select_server", { max: found.length + 1 }),
        "1",
      );
      const idx = (parseInt(choice) || 1) - 1;
      if (idx >= found.length) {
        apiBase = await ask(
          rl,
          t("setup.api_base"),
          "http://localhost:1234/v1",
        );
      } else {
        apiBase = found[Math.max(0, Math.min(found.length - 1, idx))].url;
      }
    } else {
      console.log(t("setup.no_servers"));
      apiBase = await ask(rl, t("setup.api_base"), "http://localhost:1234/v1");
    }
  } else if (provider === "openai") {
    apiBase = "https://api.openai.com/v1";
  } else if (provider === "anthropic") {
    apiBase = "https://api.anthropic.com";
  }

  const defaultKey = provider === "openai-compat" ? "not-needed" : "";
  const apiKey = await ask(rl, t("setup.api_key"), defaultKey);

  const models = await withSpinner(t("setup.fetching_spinner"), () =>
    fetchModels(apiBase, apiKey),
  );
  let model = "";
  if (models.length > 0) {
    console.log(t("setup.available_models"));
    menuList(models.slice(0, 10).map((m) => ({ label: m })));
    const choice = await ask(
      rl,
      t("setup.select_model", { max: Math.min(models.length, 10) }),
      "1",
    );
    const idx = Math.max(
      0,
      Math.min(models.length - 1, (parseInt(choice) || 1) - 1),
    );
    model = models[idx];
  } else {
    model = await ask(rl, t("setup.model_name"), "qwen3.5-9b");
  }

  const connected = await withSpinner(
    t("setup.testing_spinner", { model }),
    () => testChat(apiBase, apiKey, model),
  );
  if (connected) {
    console.log(pc.green(t("setup.ok")));
  } else {
    console.log(pc.yellow(t("setup.warning")));
  }

  console.log(t("setup.agent_settings"));
  const contextWindow = parseInt(
    await ask(rl, t("setup.context_window"), "32768"),
  );
  const maxIterations = parseInt(await ask(rl, t("setup.max_iters"), "1000"));

  // Security settings
  console.log(t("setup.security_header"));
  console.log(pc.dim(t("setup.security_status_off")));
  const configureSecurity = await ask(rl, t("setup.security_configure"), "n");
  let securityBashBlock = false;
  let securityFlagsBlock = false;
  let securityPathsDeny = true;
  if (
    configureSecurity.toLowerCase() === "y" ||
    configureSecurity.toLowerCase() === "yes"
  ) {
    securityBashBlock =
      (await ask(rl, t("setup.security_bash_block"), "n")).toLowerCase() ===
      "y";
    securityFlagsBlock =
      (await ask(rl, t("setup.security_flags_block"), "n")).toLowerCase() ===
      "y";
    securityPathsDeny =
      (await ask(rl, t("setup.security_paths_deny"), "Y")).toLowerCase() !==
      "n";
  }

  if (ownRl) rl.close();

  const answers: SetupAnswers = {
    provider,
    apiBase,
    apiKey: apiKey || "not-needed",
    model,
    contextWindow,
    maxToolIterations: maxIterations,
    locale,
    securityBashBlock,
    securityFlagsBlock,
    securityPathsDeny,
  };

  console.log(pc.green(pc.bold(t("setup.complete"))));
  const summary = renderTable(
    [
      t("setup.summary_setting"),
      t("setup.summary_value"),
      t("setup.summary_setting"),
      t("setup.summary_value"),
    ],
    [
      [t("setup.provider_type"), provider, t("setup.model_name"), model],
      [
        "API Base URL",
        apiBase,
        t("setup.context_window"),
        String(contextWindow),
      ],
      [
        t("setup.api_key"),
        apiKey || "not-needed",
        t("setup.max_iters"),
        String(maxIterations),
      ],
      [t("setup.ui_lang"), locale, "", ""],
    ],
    { maxColumns: 4 },
  );
  for (const l of summary) console.log(l);
  return answers;
}
