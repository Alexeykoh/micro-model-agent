/* MMA landing page — dictionaries (ru/en) + t() helper. */
window.LP_I18N = {
  en: {
    "meta.title": "MMA — Micro Models Agent",
    "meta.desc": "A harness-agent that keeps local 32K–64K models on task.",

    "nav.why": "Why",
    "nav.start": "Quick start",
    "nav.features": "Features",
    "nav.frontends": "Interfaces",
    "nav.serve": "Service",
    "nav.docs": "Docs",

    "hero.headline": "Micro models, big tasks",
    "hero.sub": "A harness-agent that keeps local 32K–64K models on task.",
    "hero.install": "Install",
    "hero.docs": "Documentation",
    "hero.github": "GitHub",

    "why.title": "Small models lose the thread",
    "why.b1": "A 32K–64K window fills up fast. Without a harness, the model forgets the task, re-reads the same files and repeats itself.",
    "why.b2": "MMA is engineered around that limit: a context budget, structural compaction with task/file anchors, and on-demand tool narrowing.",
    "why.b3": "Your models stay local — LM Studio or Ollama — and are left in control of nothing they cannot hold.",

    "start.title": "Quick start",
    "start.lead": "One line. Requires Bun; a local backend (LM Studio on localhost:1234, or Ollama) is all you need — no cloud account.",
    "start.win": "Windows (PowerShell):",
    "start.try": "Then just run:",
    "start.copy": "Copy",
    "start.copied": "Copied",

    "cap.title": "Capabilities",
    "cap.lead": "Everything below is the default behaviour, not a plugin pack.",
    "cap.tools": "Tools, narrowed on demand",
    "cap.tools.d": "Files, shell, search, web, a real browser and subagents. For small models only the relevant tool schemas sit in context; the rest are listed and enabled on demand.",
    "cap.context": "Context that doesn't collapse",
    "cap.context.d": "Dynamic budgets from the window size and structural compaction that preserves the task, changed files and errors — ten compactions still remember what this is about.",
    "cap.plan": "Planning with guarantees",
    "cap.plan.d": "A checklist on disk, machine-checkable step criteria, self-certification blocked and an audit gate before any final answer.",
    "cap.moe": "Mixture of Experts",
    "cap.moe.d": "A planner splits a task into specialist subtasks, validates dependencies, runs them in parallel waves and merges — falling back to single mode if it stumbles.",
    "cap.memory": "Memory that survives",
    "cap.memory.d": "Session journals, project conventions/decisions/errors as markdown, explicit remember/recall and full-text search across past sessions.",
    "cap.safety": "Safety on by default",
    "cap.safety.d": "Command, path and content validators, sandboxed file zones for subagents, AES-256-GCM session encryption and an audit journal.",
    "cap.web": "Research, without invention",
    "cap.web.d": "Search, page fetch and a Playwright browser. Web-grounding checks stop invented figures and files that were never written.",

    "frontends.title": "One core, two interfaces",
    "frontends.lead": "The terminal and the browser drive the same agent. Plugin, session and security behaviour is identical.",
    "frontends.term": "Terminal",
    "frontends.web": "Browser — mma web",
    "term.t1": "qwen3.5-9b · lmstudio · 32K",
    "term.t2": "> fix the failing tests",
    "term.t3": "◇ Reading file · test/core.spec.ts",
    "term.t4": "◇ Running command · bun test ✓",
    "term.t5": "✦ thinking · 1.2s",
    "term.t6": "⟡ 6.2K tok · 18%",
    "web.w1": "◇ Reading file · src/agent.ts",
    "web.w2": "◇ Running command · bun test ✓",
    "web.w3": "✦ composing answer…",
    "web.w4": "⟡ 6.2K tok · 18%",

    "serve.title": "Service mode — mma serve",
    "serve.body": "A long-lived, versioned HTTP API on top of the same core: a task is a turn over a session, with server-sent events, structured output, webhooks and per-tenant process isolation.",
    "serve.req": "Request",

    "phil.title": "A universal agent, not a code-only one",
    "phil.body": "Coding is one use case. Weather, smart home, APIs, research and personal assistance are others. Prompts, tool descriptions and onboarding are deliberately domain-neutral, so the agent fits whatever you point it at.",
    "phil.quiet": "Quiet by default: one line per action, detail one keystroke away.",

    "footer.docs": "Documentation",
    "footer.repo": "Repository",
    "footer.releases": "Releases",
    "footer.issues": "Issues",
    "footer.license": "MIT License",
    "footer.tagline": "An open-source harness for small language models."
  },

  ru: {
    "meta.title": "MMA — агент для микро-моделей",
    "meta.desc": "Харнесс-агент, удерживающий локальные модели 32K–64K в задаче.",

    "nav.why": "Почему",
    "nav.start": "Как запустить",
    "nav.features": "Возможности",
    "nav.frontends": "Интерфейсы",
    "nav.serve": "Сервис",
    "nav.docs": "Документация",

    "hero.headline": "Микро-модели, большие задачи",
    "hero.sub": "Харнесс-агент, удерживающий локальные модели 32K–64K в задаче.",
    "hero.install": "Установить",
    "hero.docs": "Документация",
    "hero.github": "GitHub",

    "why.title": "Маленькие модели теряют нить",
    "why.b1": "Окно 32K–64K быстро заполняется. Без харнесса модель забывает задачу, перечитывает те же файлы и повторяется.",
    "why.b2": "MMA спроектирован вокруг этого предела: бюджет контекста, структурная компакция с якорями задачи и файлов, сужение набора инструментов по требованию.",
    "why.b3": "Модели остаются локальными — LM Studio или Ollama — и получают только то, что способны удержать.",

    "start.title": "Быстрый старт",
    "start.lead": "Одна строка. Нужен Bun; локальный бэкенд (LM Studio на localhost:1234 или Ollama) — всё, что требуется. Без облачного аккаунта.",
    "start.win": "Windows (PowerShell):",
    "start.try": "Дальше просто запусти:",
    "start.copy": "Копировать",
    "start.copied": "Скопировано",

    "cap.title": "Возможности",
    "cap.lead": "Всё ниже — поведение по умолчанию, а не набор плагинов.",
    "cap.tools": "Инструменты, сужённые по требованию",
    "cap.tools.d": "Файлы, shell, поиск, веб, настоящий браузер и субагенты. Для малых моделей в контексте только нужные схемы; остальные перечислены и включаются по требованию.",
    "cap.context": "Контекст, который не рассыпается",
    "cap.context.d": "Динамические бюджеты от размера окна и структурная компакция, сохраняющая задачу, изменённые файлы и ошибки — десять сжатий всё ещё помнят суть.",
    "cap.plan": "Планирование с гарантиями",
    "cap.plan.d": "Чеклист на диске, машиночитаемые критерии шага, запрет самосертификации и аудит-шлюз перед любым финальным ответом.",
    "cap.moe": "Mixture of Experts",
    "cap.moe.d": "Планировщик делит задачу на подзадачи-специалисты, проверяет зависимости, гоняет их параллельными волнами и сливает — с откатом в одиночный режим при сбое.",
    "cap.memory": "Память, которая переживает",
    "cap.memory.d": "Журналы сессий, соглашения/решения/ошибки проекта в markdown, явные remember/recall и полнотекстовый поиск по прошлым сессиям.",
    "cap.safety": "Безопасность по умолчанию",
    "cap.safety.d": "Валидаторы команд, путей и контента, зоны файлов для субагентов, шифрование сессий AES-256-GCM и аудит-журнал.",
    "cap.web": "Исследование без выдумок",
    "cap.web.d": "Поиск, чтение страниц и браузер Playwright. Проверки не дают пройти выдуманным цифрам и файлам, которых нет.",

    "frontends.title": "Одно ядро, два интерфейса",
    "frontends.lead": "Терминал и браузер ведут один и тот же агент. Поведение плагинов, сессий и безопасности совпадает.",
    "frontends.term": "Терминал",
    "frontends.web": "Браузер — mma web",
    "term.t1": "qwen3.5-9b · lmstudio · 32K",
    "term.t2": "> починить падающие тесты",
    "term.t3": "◇ Чтение файла · test/core.spec.ts",
    "term.t4": "◇ Запуск команды · bun test ✓",
    "term.t5": "✦ думаю · 1.2s",
    "term.t6": "⟡ 6.2K tok · 18%",
    "web.w1": "◇ Чтение файла · src/agent.ts",
    "web.w2": "◇ Запуск команды · bun test ✓",
    "web.w3": "✦ формирую ответ…",
    "web.w4": "⟡ 6.2K tok · 18%",

    "serve.title": "Сервисный режим — mma serve",
    "serve.body": "Долгоживущий версионируемый HTTP API поверх того же ядра: задача — это ход над сессией, с серверными событиями, структурным выводом, вебхуками и изоляцией процессов по тенантам.",
    "serve.req": "Запрос",

    "phil.title": "Универсальный агент, а не только для кода",
    "phil.body": "Разработка — лишь один сценарий. Погода, умный дом, API, поиск и персональный ассистент — другие. Промпты, описания инструментов и онбординг намеренно домен-нейтральны, поэтому агент подходит под что угодно.",
    "phil.quiet": "Тишина по умолчанию: одна строка на действие, детали — одним нажатием.",

    "footer.docs": "Документация",
    "footer.repo": "Репозиторий",
    "footer.releases": "Релизы",
    "footer.issues": "Issues",
    "footer.license": "Лицензия MIT",
    "footer.tagline": "Открытый харнесс для маленьких языковых моделей."
  }
};

window.lpT = function (key) {
  var lang = document.documentElement.lang === "ru" ? "ru" : "en";
  var dict = window.LP_I18N[lang] || window.LP_I18N.en;
  return dict[key] || window.LP_I18N.en[key] || key;
};
