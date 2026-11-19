/* MMA landing page — dictionaries (ru/en) + t() helper. */
window.LP_I18N = {
  en: {
    "meta.title": "MMA — a harness for small local models (beta)",
    "meta.desc":
      "An agent harness that keeps local 32K–64K models on task: context budget, structural compaction, real execution guarantees.",

    "nav.try": "Try",
    "nav.why": "Why",
    "nav.context": "Context",
    "nav.interfaces": "Interfaces",
    "nav.safety": "Safety",
    "nav.limits": "Limits",
    "nav.docs": "Docs",

    "hero.kicker": "open source · local-first · general purpose",
    "hero.headline": "Small models.<br>Real work.",
    "hero.lead":
      "MMA is a harness that keeps local 32K–64K models on task — with a context budget, structural compaction, planning that is verified, and safety on by default.",
    "hero.source": "Read the source",
    "hero.note":
      "Runs locally against LM Studio, Ollama, llama.cpp or vLLM — or against a hosted provider such as OpenRouter, OpenAI, Anthropic or OpenCode Zen. No cloud account required. Currently in beta — the interface and features are still changing.",
    beta: "beta",

    "a11y.skip": "Skip to content",
    "a11y.top": "Back to top",
    greet: "Hi! I'm MMART",

    "stats.ctx": "32K–64K",
    "stats.ctx.l": "target context window",
    "stats.tools": "~3.5K",
    "stats.tools.l": "tokens a full toolset costs",
    "stats.narrow": "on demand",
    "stats.narrow.l": "tools are narrowed to the task",
    "stats.license": "MIT",
    "stats.license.l": "open source, no telemetry",

    "s1.n": "01",
    "s1.k": "Try",
    "try.title": "Thirty seconds in the terminal",
    "try.lead":
      "One command installs a self-contained build. One line runs a task. This is what a turn looks like in quiet mode — one line per action, nothing else.",
    "terminal.caption": "an MMA turn · quiet mode",
    "terminal.replay": "Replay",
    "term.l1": '$ mma "fix the failing tests"',
    "term.l2": "qwen3.5-9b · lmstudio · 32K · plugins 2 · mcp 1",
    "term.l3": "◇ plan · 3 steps",
    "term.l4": "◇ reading file · test/core.spec.ts",
    "term.l5": "◇ reading file · src/core.ts",
    "term.l6": "◇ editing file · src/core.ts  ✓",
    "term.l7": "◇ running command · bun test  ✓ 14 passed",
    "term.l8": "✦ thinking · 2.1s",
    "term.l9": "✓ done · 3/3 steps · 6.2K tok · 18%",
    "try.q1": "one-shot: a single request, then exit",
    "try.q2": "the interactive terminal — sessions, hotkeys, slash commands",
    "try.q3": "the first-run provider wizard",
    "try.q4": "the same agent in a browser, per-session runners",

    "s2.n": "02",
    "s2.k": "Why",
    "why.title": "Built for the context ceiling",
    "why.lead":
      "A 32K–64K window fills fast. Without a strategy, an agent loses the task, re-reads the same files and reports results before they are verified. MMA takes that constraint as given.",
    "why.r1.t": "Context that does not collapse",
    "why.r1.d":
      "Budgets come from the model's window. Compaction is structural: it keeps the task, the plan, the files and the errors — not a summary of the conversation. A [Tool ledger] stops re-reads.",
    "why.r2.t": "Results you can check",
    "why.r2.d":
      "A plan step carries a machine-checkable criterion and closes only when its files really changed on disk. Claims are checked against real paths and real exit codes, then reviewed by a second pass.",
    "why.r3.t": "Honest failures",
    "why.r3.d":
      "Loops, repeated calls and failing command streaks stop the run with a truthful status. Fail-open paths are logged with a reason, so a breakdown is never indistinguishable from success.",
    "why.p1":
      "The rule is simple: nothing important lives only in the context. Anchors are re-injected after every compaction, and the plan checklist is read back from disk.",
    "why.before": "A plain chat agent",
    "why.b1": "Task drifts after a couple of compactions",
    "why.b2": "The same files are read again and again",
    "why.b3": "“Done” with no file and no exit code",
    "why.after": "MMA",
    "why.a1": "Task, plan and changed files survive every compaction",
    "why.a2": "Irrelevant tool schemas stay out of the context window",
    "why.a3": "Claims are checked against real files and command results",

    "s3.n": "03",
    "s3.k": "Context",
    "context.title": "The budget is derived, not guessed",
    "context.lead":
      "The window is detected from the provider or pinned by hand. From it MMA derives the system share, the response reserve and the history budget — and compacts structurally before the window overflows.",
    "budget.pick": "Pick a model's context window",
    "ctx.th.system": "System",
    "ctx.th.history": "History",
    "ctx.th.reserve": "Reserve",
    "ctx.note":
      "Compaction fires at 75% of the history budget, and the last six exchanges always stay intact. A quality score with a floor prevents the compaction death-spiral.",
    "ctx.anchor.title": "Anchors, re-injected after every compaction",
    "ctx.a1": "the original request of the turn",
    "ctx.a2": "the plan checklist, read back from disk",
    "ctx.a3": "created, changed and deleted files",
    "ctx.a4": "files already read, so they are not read again",
    "ctx.a5": "repeated errors and what was already tried",

    "s4.n": "04",
    "s4.k": "Interfaces",
    "ifaces.title": "One core, four ways to drive it",
    "ifaces.lead":
      "The same agent, the same sessions, the same tools and the same enforcement — only the transport changes. Pick by who is driving.",
    "ifaces.i1":
      "One-shot. A single request, machine-readable --json, a sandboxed -d directory, exit on the first answer.",
    "ifaces.i2":
      "Terminal. A persistent REPL with sessions, hotkeys, slash commands and markdown→ANSI rendering. No TUI.",
    "ifaces.i3":
      "Browser. SSE + REST over the same core: per-session runners, so several tasks run at once, plus panes for files, LSP, trace, plugins and map.",
    "ifaces.i4":
      "HTTP service. Agent Service API v1 — sessions, tasks, SSE, HMAC webhooks, and a live OpenAPI 3.1 spec at /v1/openapi.json.",
    "ifaces.tools.title": "The toolset is narrowed to the task",
    "ifaces.tools.lead":
      "A full toolset costs roughly 3.5K tokens on every request — about a ninth of a 32K window. Only the relevant schemas sit in context; the rest are listed compactly and enabled when asked. Structural tools are always visible.",
    "ifaces.tools.always":
      "plan · plan_step · todo · verify · project_map · lsp_check · question · approve · load_skill · enable_tools · set_thinking · session_info · define_capability",
    "ifaces.more":
      "Files, shell, web search and a real Playwright browser, subagents with their own file zone, memory, pipelines, MCP, LSP diagnostics, documents and images — the full list and the per-tool contracts are in the documentation.",

    "s5.n": "05",
    "s5.k": "Safety",
    "safety.title": "Safe by default",
    "safety.lead":
      "Every tool call passes one validation pipeline before it touches the disk or the network. A blocked call never reaches the filesystem, and the block is written to an audit journal.",
    "safety.pipe": "call → plugins → validators → action → plugins → result",
    "safety.step1": "call",
    "safety.step2": "plugins",
    "safety.step3": "validators",
    "safety.step4": "action",
    "safety.step5": "plugins",
    "safety.step6": "result",
    "safety.f4":
      "Egress policy (DLP): before a call leaves for an external provider, absolute paths, machine and user names, environment values, secrets and PII are replaced with stable tokens. Loopback keeps the real values.",
    "safety.f5":
      "Session files can be encrypted with AES-256-GCM, logs are scrubbed of secrets, and an audit notifier can ship events to a file or a webhook.",
    "safety.more":
      "Presets: strict · balanced (default) · permissive. The kill switch for egress redaction is security.dataPolicy.enabled: false.",

    "s6.n": "06",
    "s6.k": "Limits",
    "lim.title": "Honest limits",
    "lim.lead":
      "What MMA does not do — so you can decide whether it fits before you invest an afternoon.",
    "lim.l1":
      "Disabling a plugin is not a sandbox. The module is already loaded, and its declared permissions are shown, not enforced.",
    "lim.l2":
      "It helps a small model; it cannot hand a small model a bigger context window. The real ceiling still depends on the model you run.",
    "lim.l3":
      "A local backend is the bottleneck: one model on one machine. Parallel sessions share the same engine, so they do not make it faster.",
    "lim.l4":
      "Local-first means you own the compute and the uptime. There is no hosted SLA behind it.",
    "lim.l5":
      "The context probe is best-effort. A bare /models endpoint reports nothing, so the configured window simply stands.",

    "s7.n": "07",
    "s7.k": "FAQ",
    "faq.title": "Before you install",
    "faq.q1": "Do I need Node.js or Bun?",
    "faq.a1":
      "No. The installer downloads a self-contained build with a bundled Bun runtime, the agent and its dependencies. Nothing else is required.",
    "faq.q2": "Which backend should I use?",
    "faq.a2":
      "Any OpenAI-compatible server. LM Studio on localhost:1234 and Ollama on localhost:11434 work out of the box; llama.cpp, vLLM and hosted providers work too. Tool-calling support is required.",
    "faq.q3": "Does it work offline?",
    "faq.a3":
      "Yes, if the model and the provider are local. Web search, the browser tool and hosted providers need a network.",
    "faq.q4": "Is there telemetry?",
    "faq.a4":
      "No. Sessions, memory and logs stay in ~/.mma. The only outbound calls are the ones you configure — the provider, web tools and updates.",
    "faq.q5": "How do I update?",
    "faq.a5":
      "Re-run the same install command. It downloads the newest release into ~/.mma/versions/ and flips current; the previous version stays for a rollback.",

    "install.copy": "Copy",
    "install.copied": "Copied",
    "install.or": "or download a build",
    "install.manual": "Manual install from the tarball (no script)",
    "install.manual_note":
      "The archives already contain the runtime. Extract anywhere and run the launcher — no admin rights, no Node.js, no npm.",
    "install.manual_more": "Checksums, PATH setup, updates, Gatekeeper/SmartScreen",

    "footer.tagline": "An open-source harness for small language models.",
    "footer.project": "Project",
    "footer.docs": "Documentation",
    "footer.fulldocs": "Full documentation",
    "footer.repo": "Repository",
    "footer.download": "Download latest",
    "footer.releases": "Releases",
    "footer.issues": "Issues",
    "footer.license": "MIT License",
    "footer.changelog": "Changelog",
  },

  ru: {
    "meta.title": "MMA — харнесс для маленьких локальных моделей (бета)",
    "meta.desc":
      "Агент-харнесс, удерживающий локальные модели 32K–64K в задаче: бюджет контекста, структурная компакция, реальные гарантии исполнения.",

    "nav.try": "Попробовать",
    "nav.why": "Почему",
    "nav.context": "Контекст",
    "nav.interfaces": "Интерфейсы",
    "nav.safety": "Безопасность",
    "nav.limits": "Ограничения",
    "nav.docs": "Документация",

    "hero.kicker": "open source · local-first · универсальный",
    "hero.headline": "Маленькие модели.<br>Настоящая работа.",
    "hero.lead":
      "MMA — харнесс, который удерживает локальные модели 32K–64K в задаче: бюджет контекста, структурная компакция, проверяемое планирование и безопасность по умолчанию.",
    "hero.source": "Открыть исходники",
    "hero.note":
      "Работает локально с LM Studio, Ollama, llama.cpp или vLLM — либо с hosted-провайдером: OpenRouter, OpenAI, Anthropic, OpenCode Zen. Облачный аккаунт не нужен. Сейчас это бета — интерфейс и возможности ещё меняются.",
    beta: "бета",

    "a11y.skip": "К основному содержимому",
    "a11y.top": "Наверх",
    greet: "Привет! Я MMART",

    "stats.ctx": "32K–64K",
    "stats.ctx.l": "целевое контекстное окно",
    "stats.tools": "~3.5K",
    "stats.tools.l": "токенов стоит полный набор инструментов",
    "stats.narrow": "по требованию",
    "stats.narrow.l": "набор инструментов сужается под задачу",
    "stats.license": "MIT",
    "stats.license.l": "открытый код, без телеметрии",

    "s1.n": "01",
    "s1.k": "Попробовать",
    "try.title": "Тридцать секунд в терминале",
    "try.lead":
      "Одна команда ставит самодостаточную сборку. Одна строка запускает задачу. Так выглядит ход в тихом режиме — одна строка на действие, ничего лишнего.",
    "terminal.caption": "ход MMA · тихий режим",
    "terminal.replay": "Повторить",
    "term.l1": '$ mma "почини падающие тесты"',
    "term.l2": "qwen3.5-9b · lmstudio · 32K · плагины 2 · mcp 1",
    "term.l3": "◇ план · 3 шага",
    "term.l4": "◇ чтение файла · test/core.spec.ts",
    "term.l5": "◇ чтение файла · src/core.ts",
    "term.l6": "◇ правка файла · src/core.ts  ✓",
    "term.l7": "◇ запуск команды · bun test  ✓ 14 passed",
    "term.l8": "✦ размышляю · 2.1s",
    "term.l9": "✓ готово · 3/3 шага · 6.2K tok · 18%",
    "try.q1": "разовый запуск: один запрос и выход",
    "try.q2": "интерактивный терминал — сессии, хоткеи, slash-команды",
    "try.q3": "мастер первичной настройки провайдера",
    "try.q4": "тот же агент в браузере, раннеры на сессию",

    "s2.n": "02",
    "s2.k": "Почему",
    "why.title": "Сделан под потолок контекста",
    "why.lead":
      "Окно 32K–64K заполняется быстро. Без стратегии агент теряет задачу, перечитывает одни и те же файлы и сообщает результат до проверки. MMA исходит из этого ограничения.",
    "why.r1.t": "Контекст не рассыпается",
    "why.r1.d":
      "Бюджеты выводятся из окна модели. Компакция структурная: она сохраняет задачу, план, файлы и ошибки, а не краткий пересказ переписки. [Tool ledger] не даёт перечитывать одно и то же.",
    "why.r2.t": "Результат можно проверить",
    "why.r2.d":
      "У шага плана есть машинно-проверяемый критерий, и он закрывается только когда его файлы реально изменились на диске. Утверждения сверяются с реальными путями и кодами возврата, затем проходят вторую проверку.",
    "why.r3.t": "Честные отказы",
    "why.r3.d":
      "Циклы, повторные вызовы и серии падающих команд останавливают прогон с правдивым статусом. Fail-open пути пишут причину, поэтому поломка неотличима от успеха только на бумаге.",
    "why.p1":
      "Правило простое: ничто важное не живёт только в контексте. Якоря вставляются заново после каждого сжатия, а чеклист плана перечитывается с диска.",
    "why.before": "Обычный чат-агент",
    "why.b1": "Задача уплывает после пары сжатий",
    "why.b2": "Одни и те же файлы читаются снова и снова",
    "why.b3": "«Готово» без файла и без кода возврата",
    "why.after": "MMA",
    "why.a1": "Задача, план и изменённые файлы переживают каждое сжатие",
    "why.a2": "Ненужные схемы инструментов не занимают контекстное окно",
    "why.a3": "Утверждения сверяются с реальными файлами и командами",

    "s3.n": "03",
    "s3.k": "Контекст",
    "context.title": "Бюджет выводится, а не угадывается",
    "context.lead":
      "Окно определяется от провайдера или задаётся вручную. Из него MMA выводит долю системы, резерв ответа и бюджет истории — и сжимает структурно до переполнения окна.",
    "budget.pick": "Выберите контекстное окно модели",
    "ctx.th.system": "Система",
    "ctx.th.history": "История",
    "ctx.th.reserve": "Запас",
    "ctx.note":
      "Сжатие срабатывает на 75% бюджета истории, а последние шесть обменов всегда остаются целиком. Оценка качества с нижним порогом не даёт уйти в спираль бесконечных сжатий.",
    "ctx.anchor.title": "Якоря, вставляемые заново после каждого сжатия",
    "ctx.a1": "исходный запрос хода",
    "ctx.a2": "чеклист плана, перечитанный с диска",
    "ctx.a3": "созданные, изменённые и удалённые файлы",
    "ctx.a4": "уже прочитанные файлы — чтобы не читать их снова",
    "ctx.a5": "повторяющиеся ошибки и то, что уже пробовали",

    "s4.n": "04",
    "s4.k": "Интерфейсы",
    "ifaces.title": "Одно ядро — четыре способа управления",
    "ifaces.lead":
      "Тот же агент, те же сессии, те же инструменты и тот же enforcement — меняется только транспорт. Выбирайте по тому, кто водит.",
    "ifaces.i1":
      "Разовый запуск. Один запрос, машиночитаемый --json, песочница -d, выход по первому ответу.",
    "ifaces.i2":
      "Терминал. Постоянный REPL с сессиями, хоткеями, slash-командами и markdown→ANSI. Без TUI.",
    "ifaces.i3":
      "Браузер. SSE + REST поверх того же ядра: раннеры на сессию, поэтому несколько задач идут одновременно, плюс панели файлов, LSP, Trace, плагинов и карты.",
    "ifaces.i4":
      "HTTP-сервис. Agent Service API v1 — сессии, задачи, SSE, вебхуки с HMAC и живой OpenAPI 3.1 в /v1/openapi.json.",
    "ifaces.tools.title": "Набор инструментов сужается под задачу",
    "ifaces.tools.lead":
      "Полный набор — это примерно 3.5K токенов на каждый запрос, около девятой части окна 32K. В контексте только нужные схемы; остальные кратко перечислены и включаются по запросу. Структурные инструменты видны всегда.",
    "ifaces.tools.always":
      "plan · plan_step · todo · verify · project_map · lsp_check · question · approve · load_skill · enable_tools · set_thinking · session_info · define_capability",
    "ifaces.more":
      "Файлы, команды, веб-поиск и настоящий браузер Playwright, субагенты со своей зоной файлов, память, пайплайны, MCP, LSP-диагностика, документы и изображения — полный список и контракты инструментов в документации.",

    "s5.n": "05",
    "s5.k": "Безопасность",
    "safety.title": "Безопасно по умолчанию",
    "safety.lead":
      "Каждый вызов инструмента проходит один конвейер валидации, прежде чем коснуться диска или сети. Заблокированный вызов не доходит до файловой системы, а блокировка пишется в аудит-журнал.",
    "safety.pipe": "вызов → плагины → валидаторы → действие → плагины → результат",
    "safety.step1": "вызов",
    "safety.step2": "плагины",
    "safety.step3": "валидаторы",
    "safety.step4": "действие",
    "safety.step5": "плагины",
    "safety.step6": "результат",
    "safety.f4":
      "Политика egress (DLP): перед отправкой внешнему провайдеру абсолютные пути, имена машины и пользователя, переменные окружения, секреты и ПДн заменяются стабильными токенами. Loopback видит реальные значения.",
    "safety.f5":
      "Файлы сессий можно шифровать AES-256-GCM, логи очищаются от секретов, а аудит-нотификатор умеет отдавать события в файл или вебхук.",
    "safety.more":
      "Пресеты: strict · balanced (по умолчанию) · permissive. Выключатель редакции egress — security.dataPolicy.enabled: false.",

    "s6.n": "06",
    "s6.k": "Ограничения",
    "lim.title": "Честные ограничения",
    "lim.lead":
      "Чего MMA не делает — чтобы вы решили, подходит ли он, прежде чем тратить вечер.",
    "lim.l1":
      "Отключение плагина — не песочница. Модуль уже загружен, а заявленные права показываются, но не принуждаются.",
    "lim.l2":
      "Он помогает маленькой модели, но не даёт ей большее контекстное окно. Потолок по-прежнему задаёт модель, которую вы запускаете.",
    "lim.l3":
      "Локальный бэкенд — узкое место: одна модель на одной машине. Параллельные сессии делят один движок и не делают его быстрее.",
    "lim.l4":
      "Local-first — значит вы владеете железом и его простоями. За этим не стоит облачный SLA.",
    "lim.l5":
      "Проба контекста работает по возможности. Голый /models ничего не сообщает — тогда просто остаётся настроенное окно.",

    "s7.n": "07",
    "s7.k": "FAQ",
    "faq.title": "Перед установкой",
    "faq.q1": "Нужны ли Node.js или Bun?",
    "faq.a1":
      "Нет. Установщик скачивает самодостаточную сборку со встроенным Bun runtime, агентом и зависимостями. Больше ничего не требуется.",
    "faq.q2": "Какой бэкенд выбрать?",
    "faq.a2":
      "Любой OpenAI-совместимый сервер. LM Studio на localhost:1234 и Ollama на localhost:11434 работают из коробки; llama.cpp, vLLM и hosted-провайдеры тоже. Нужна поддержка tool-calling.",
    "faq.q3": "Работает ли офлайн?",
    "faq.a3":
      "Да, если модель и провайдер локальные. Веб-поиск, браузерный инструмент и hosted-провайдеры требуют сети.",
    "faq.q4": "Есть ли телеметрия?",
    "faq.a4":
      "Нет. Сессии, память и логи остаются в ~/.mma. Исходящие вызовы — только те, что вы настроили: провайдер, веб-инструменты и обновления.",
    "faq.q5": "Как обновляться?",
    "faq.a5":
      "Запустите ту же установочную команду. Она скачает новый релиз в ~/.mma/versions/ и переключит current; прежняя версия останется для отката.",

    "install.copy": "Копировать",
    "install.copied": "Скопировано",
    "install.or": "или скачайте сборку",
    "install.manual": "Ручная установка из архива (без скрипта)",
    "install.manual_note":
      "В архиве уже есть runtime. Распакуйте в любой каталог и запустите — без прав администратора, без Node.js и npm.",
    "install.manual_more": "Контрольные суммы, PATH, обновления, Gatekeeper/SmartScreen",

    "footer.tagline": "Открытый харнесс для маленьких языковых моделей.",
    "footer.project": "Проект",
    "footer.docs": "Документация",
    "footer.fulldocs": "Полная документация",
    "footer.repo": "Репозиторий",
    "footer.download": "Скачать последнюю",
    "footer.releases": "Релизы",
    "footer.issues": "Issues",
    "footer.license": "Лицензия MIT",
    "footer.changelog": "Changelog",
  },
};

window.lpT = function (key) {
  var lang = document.documentElement.lang === "ru" ? "ru" : "en";
  var dict = window.LP_I18N[lang] || window.LP_I18N.en;
  return dict[key] || window.LP_I18N.en[key] || key;
};
