import * as readline from "readline";
import { t, setLocale } from "../i18n/index";

interface SetupAnswers {
  provider: string;
  apiBase: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxToolIterations: number;
  locale: string;
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

export async function runSetup(): Promise<SetupAnswers> {
  console.log(t("setup.title"));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(t("setup.language"));
  const locale = await ask(rl, t("setup.ui_lang"), "en");
  setLocale(locale);

  console.log(t("setup.select_provider"));
  PROVIDER_TYPES.forEach((p, i) => console.log(`    ${i + 1}. ${p.label}`));
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
    console.log(t("setup.scanning"));
    const found = await scanPorts();

    if (found.length > 0) {
      console.log(t("setup.found_servers", { count: found.length }));
      found.forEach((f, i) =>
        console.log(`    ${i + 1}. ${f.label.padEnd(14)} ${f.url}`),
      );
      console.log(`    ${found.length + 1}. ${t("setup.custom_url")}`);
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

  console.log(t("setup.fetching_models"));
  const models = await fetchModels(apiBase, apiKey);
  let model = "";
  if (models.length > 0) {
    console.log(t("setup.available_models"));
    models.slice(0, 10).forEach((m, i) => console.log(`    ${i + 1}. ${m}`));
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

  console.log(t("setup.testing", { model }));
  const connected = await testChat(apiBase, apiKey, model);
  if (connected) {
    console.log(t("setup.ok"));
  } else {
    console.log(t("setup.warning"));
  }

  console.log(t("setup.agent_settings"));
  const contextWindow = parseInt(
    await ask(rl, t("setup.context_window"), "32768"),
  );
  const maxIterations = parseInt(await ask(rl, t("setup.max_iters"), "25"));

  rl.close();

  const answers: SetupAnswers = {
    provider,
    apiBase,
    apiKey: apiKey || "not-needed",
    model,
    contextWindow,
    maxToolIterations: maxIterations,
    locale,
  };

  console.log(t("setup.complete"));
  return answers;
}
