import { pc } from "../ui/colors";
import { t, setLocale } from "../i18n/index";
import { Spinner } from "../ui/spinner";
import { BUILTIN_PROVIDERS, HOSTED_BASE_URLS } from "../modules/providers/presets";
import { box } from "../ui/box";
import { getDefaultChannel } from "../output";
import { SetupPrompt, type PromptInput } from "./setup-prompt";

export interface SetupAnswers {
  provider: string;
  apiBase: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxToolIterations: number;
  locale: string;
  securityBashBlock: boolean;
  securityFlagsBlock: boolean;
  securityPathsRestrict: boolean;
}

async function withSpinner<T>(message: string, fn: () => Promise<T>): Promise<T> {
  const spinner = new Spinner({ channel: getDefaultChannel() });
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
    (it, i) => ` ${pc.cyan(`[${i + 1}]`)} ${it.label}${it.url ? `  ${pc.dim(it.url)}` : ""}`,
  );
  for (const l of box(lines, { width: 72 })) getDefaultChannel().writeLine(l);
}

function ask(rl: PromptInput, question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(prompt, (answer: string) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

/** Parse a positive integer answer, falling back to the prompt's default. */
function askInt(rl: PromptInput, question: string, defaultValue: number): Promise<number> {
  return ask(rl, question, String(defaultValue)).then((raw) => {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : defaultValue;
  });
}

const PROVIDER_TYPES = BUILTIN_PROVIDERS.map((spec) => ({
  value: spec.type,
  label: spec.label,
}));

/** UI languages offered by the wizard (labels stay in their own language). */
const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "ru", label: "Русский" },
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

async function testChat(apiBase: string, apiKey: string, model: string): Promise<boolean> {
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

export async function runSetup(externalRl?: PromptInput): Promise<SetupAnswers> {
  getDefaultChannel().writeLine(t("setup.title"));

  const rl: PromptInput = externalRl ?? new SetupPrompt();
  const ownRl = !externalRl;

  getDefaultChannel().writeLine(t("setup.language"));
  menuList(LANGUAGES);
  const languageChoice = await ask(
    rl,
    t("setup.select_language_num", { max: LANGUAGES.length }),
    "1",
  );
  const typedLang = languageChoice.trim().toLowerCase();
  const byCode = LANGUAGES.find((l) => l.value === typedLang);
  const locale = byCode
    ? byCode.value
    : LANGUAGES[
        Math.max(0, Math.min(LANGUAGES.length - 1, (parseInt(languageChoice) || 1) - 1))
      ].value;
  setLocale(locale);

  getDefaultChannel().writeLine(t("setup.select_provider"));
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
    const found = await withSpinner(t("setup.scanning_spinner"), async () => scanPorts());

    if (found.length > 0) {
      getDefaultChannel().writeLine(t("setup.found_servers", { count: found.length }));
      menuList([
        ...found.map((f) => ({ label: f.label, url: f.url })),
        { label: t("setup.custom_url") },
      ]);
      const choice = await ask(rl, t("setup.select_server", { max: found.length + 1 }), "1");
      const idx = (parseInt(choice) || 1) - 1;
      if (idx >= found.length) {
        apiBase = await ask(rl, t("setup.api_base"), "http://localhost:1234/v1");
      } else {
        apiBase = found[Math.max(0, Math.min(found.length - 1, idx))].url;
      }
    } else {
      getDefaultChannel().writeLine(t("setup.no_servers"));
      apiBase = await ask(rl, t("setup.api_base"), "http://localhost:1234/v1");
    }
  } else {
    apiBase = HOSTED_BASE_URLS[provider] ?? "";
  }

  const defaultKey = provider === "openai-compat" ? "not-needed" : "";
  const apiKey = await ask(rl, t("setup.api_key"), defaultKey);

  const models = await withSpinner(t("setup.fetching_spinner"), () => fetchModels(apiBase, apiKey));
  let model = "";
  if (models.length > 0) {
    getDefaultChannel().writeLine(t("setup.available_models"));
    menuList(models.slice(0, 10).map((m) => ({ label: m })));
    const choice = await ask(
      rl,
      t("setup.select_model", { max: Math.min(models.length, 10) }),
      "1",
    );
    const idx = Math.max(0, Math.min(models.length - 1, (parseInt(choice) || 1) - 1));
    model = models[idx];
  } else {
    model = await ask(rl, t("setup.model_name"), "qwen/qwen3.5-9b");
  }

  const connected = await withSpinner(t("setup.testing_spinner", { model }), () =>
    testChat(apiBase, apiKey, model),
  );
  if (connected) {
    getDefaultChannel().writeLine(pc.green(t("setup.ok")));
  } else {
    getDefaultChannel().writeLine(pc.yellow(t("setup.warning")));
  }

  getDefaultChannel().writeLine(t("setup.agent_settings"));
  const contextWindow = await askInt(rl, t("setup.context_window"), 32768);
  const maxIterations = await askInt(rl, t("setup.max_iters"), 1000);

  // Security settings
  getDefaultChannel().writeLine(t("setup.security_header"));
  getDefaultChannel().writeLine(pc.dim(t("setup.security_status_on")));
  const configureSecurity = await ask(rl, t("setup.security_configure"), "n");
  let securityBashBlock = false;
  let securityFlagsBlock = false;
  let securityPathsRestrict = false;
  if (configureSecurity.toLowerCase() === "y" || configureSecurity.toLowerCase() === "yes") {
    securityBashBlock = (await ask(rl, t("setup.security_bash_block"), "n")).toLowerCase() === "y";
    securityFlagsBlock =
      (await ask(rl, t("setup.security_flags_block"), "n")).toLowerCase() === "y";
    const pathsAnswer = (await ask(rl, t("setup.security_paths_restrict"), "Y")).toLowerCase();
    securityPathsRestrict = pathsAnswer !== "n" && pathsAnswer !== "no";
  }

  if (ownRl) {
    // Detach the prompt reader and pause stdin so the REPL's raw-mode
    // LineEditor can take over cleanly (no readline/raw-mode state left).
    (rl as SetupPrompt).close();
  }

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
    securityPathsRestrict,
  };

  getDefaultChannel().writeLine(pc.green(pc.bold(t("setup.complete"))));
  const summary: Array<[string, string]> = [
    [t("setup.provider_type"), provider],
    [t("setup.model_name"), model],
    [t("setup.api_base"), apiBase],
    [t("setup.api_key"), apiKey || "not-needed"],
    [t("setup.context_window"), String(contextWindow)],
    [t("setup.max_iters"), String(maxIterations)],
    [t("setup.ui_lang"), locale],
  ];
  for (const [label, value] of summary) {
    getDefaultChannel().writeLine(`  ${pc.yellow(label.trim())}: ${pc.white(value)}`);
  }
  return answers;
}
