# MMA v2 — Схемы архитектуры

## 1. Запуск системы

```mermaid
flowchart TD
    START["mma &lt;prompt&gt; или mma init"] --> PARSE["cli/main.ts<br/>разбор аргументов"]
    PARSE --> INIT{"init команда?"}
    
    INIT -->|да| WIZARD["cli/setup.ts<br/>мастер настройки"]
    WIZARD --> SCAN["сканирование localhost портов<br/>:1234 :11434 :8000"]
    SCAN --> DETECT{"серверы<br/>найдены?"}
    DETECT -->|да| LIST["показать найденные серверы"]
    DETECT -->|нет| MANUAL["ввести URL вручную"]
    LIST --> PICK["выбор сервера + модели"]
    MANUAL --> PICK
    PICK --> TEST["проверка подключения<br/>/v1/models + chat('hi')"]
    TEST -->|ok| SAVE["сохранить ~/.mma/config.json"]
    TEST -->|ошибка| RETRY["повторить или сменить"]
    SAVE --> DONE["выход"]
    
    INIT -->|нет| LOAD["загрузка конфига<br/>defaults → global → project"]
    LOAD --> MODULES["инициализация модулей<br/>skills, plugins, mcp, indexer,<br/>memory, user-profile, context"]
    MODULES --> REGTOOLS["регистрация инструментов<br/>из модулей в ToolRegistry"]
    REGTOOLS --> PBUILD["сборка system prompt<br/>PromptBlock[] от модулей,<br/>сортировка по priority, 8K бюджет"]
    PBUILD --> LOOP["вход в цикл агента"]
    
    LOOP --> REPL{"есть prompt?"}
    REPL -->|нет, диалог| REPLLOOP["cli/repl.ts<br/>readline цикл"]
    REPLLOOP -->|пользователь печатает| COMPLETER["автокомплит<br/>cli/completer.ts"]
    COMPLETER -->|slash команда| CMD["выполнить команду<br/>help, model, config, exit"]
    COMPLETER -->|текст| SEND["отправить в цикл агента"]
    SEND --> LOOP
    
    REPL -->|да, CLI режим| SEND
```

---

## 2. Система регистрации модулей

```mermaid
flowchart LR
    subgraph MODULES["Модули"]
        SK["skills/"]
        PL["plugins/"]
        MCP["mcp/"]
        PIP["pipelines/"]
        IDX["indexer/"]
        MEM["memory/"]
        UP["user-profile/"]
        CTX["context/"]
        HAL["hallucination/"]
        UPD["updater/"]
        EXEC["execution/"]
    end
    
    subgraph CORE["Ядро"]
        MR["ModuleRegistry"]
        TR["ToolRegistry"]
        PB["PromptBuilder"]
        PM["PluginManager"]
    end
    
    SK -->|getPlugin| PM
    PL -->|getPlugin| PM
    MCP -->|getTools| TR
    PIP -->|getTools| TR
    IDX -->|getPromptBlock| PB
    MEM -->|getPromptBlock| PB
    UP -->|getPromptBlock| PB
    CTX -->|getPlugin| PM
    HAL -->|getPlugin| PM
    UPD -->|getPlugin| PM
    EXEC -->|getPlugin| PM
    EXEC -->|getPromptBlock| PB
    EXEC -->|getTools| TR
    
    MR -->|collectBlocks| PB
    MR -->|collectTools| TR
    MR -->|collectPlugins| PM
```

---

## 3. Цикл агента (конечный автомат)

```mermaid
stateDiagram-v2
    direction LR
    
    [*] --> INIT: старт сессии
    
    INIT --> THINK: сборка контекста<br/>(system prompt + история)
    
    THINK --> ACT: ответ содержит tool_calls
    THINK --> OUTPUT: ответ — текст
    THINK --> THINK: обнаружена галлюцинация<br/>→ повтор с контекстом
    
    ACT --> OBSERVE: инструмент выполнен
    
    OBSERVE --> THINK: нужны ещё шаги<br/>(проверка compaction)
    OBSERVE --> [*]: задача выполнена
    
    OUTPUT --> [*]: ожидание ввода пользователя
    
    ERROR --> THINK: повторить инструмент
    ERROR --> [*]: превышен лимит попыток
```

---

## 4. Конвейер выполнения инструментов

```mermaid
flowchart TB
    LLM["LLM вернула tool_call"] --> PARSE["разбор JSON аргументов"]
    PARSE --> VALIDATE["валидация по схеме<br/>tool definition"]
    
    VALIDATE --> PLUGIN_BEFORE["Plugin:onBeforeTool"]
    
    PLUGIN_BEFORE --> BLOCK{"плагин вернул<br/>false?"}
    BLOCK -->|да| BLOCKED["блокировка выполнения<br/>возврат ошибки LLM"]
    BLOCK -->|нет| EXECUTE["выполнение handler()"]
    
    EXECUTE --> RESULT["ToolResult { success, output }"]
    RESULT --> PLUGIN_AFTER["Plugin:onAfterTool"]
    
    PLUGIN_AFTER --> HALLUC_CHECK["hallucination: проверка<br/>(фактические пути vs известные)"]
    HALLUC_CHECK --> LOG["запись в историю сессии<br/>JSONL"]
    
    LOG --> RETURN["возврат в цикл агента"]
    
    style BLOCK fill:#ffcccc
    style BLOCKED fill:#ff6666
```

---

## 5. Взаимодействие REPL

```mermaid
sequenceDiagram
    participant U as Пользователь
    participant R as REPL (repl.ts)
    participant C as Completer (completer.ts)
    participant A as Цикл агента
    participant LLM as LLM провайдер

    U->>R: /model use <TAB>
    R->>C: complete("/model use ")
    C->>C: поиск ModelArgProvider
    C->>C: чтение моделей из конфига
    C-->>R: ["qwen3.5-9b", "llama-3.2-3b"]
    R-->>U: показать варианты

    U->>R: /model use qwen3.5-9b
    R->>R: выполнить команду → обновить конфиг

    U->>R: напиши тесты для auth
    R->>A: run("напиши тесты для auth")
    A->>A: сборка контекста
    A->>LLM: chat(messages)
    LLM-->>A: стриминг ответа
    A-->>R: форматированные чанки
    R-->>U: markdown → ANSI

    U->>R: Ctrl+R
    R->>R: поиск по истории
    R-->>U: строка поиска /model use
    U->>R: enter → повторить

    U->>R: Ctrl+C
    R->>R: отмена, возврат к промпту
```

---

## 6. Компакшен контекста

```mermaid
flowchart TD
    CHECK{"history > 75% бюджета<br/>или > 15 итераций?"}
    CHECK -->|нет| KEEP["оставить полный контекст"]
    CHECK -->|да| COMPACT["начать компакшен"]
    
    COMPACT --> DIVIDE["разделить разговор"]
    DIVIDE --> RECENT["последние 6 туров<br/>без изменений"]
    DIVIDE --> OLD["старые туры<br/>сжать"]
    
    OLD --> EXTRACT["извлечь структурированные данные"]
    EXTRACT --> FACTS["факты + решения"]
    EXTRACT --> RESULTS["результаты инструментов (кратко)"]
    EXTRACT --> ERRORS["ошибки (полностью)"]
    EXTRACT --> PLAN["активный план (полностью)"]
    
    FACTS --> MERGE["слить с предыдущим<br/>сжатым блоком"]
    RESULTS --> MERGE
    ERRORS --> MERGE
    PLAN --> MERGE
    
    MERGE --> BLOCK["собрать сжатый блок<br/>[Сжато: N итераций, M инструментов]"]
    BLOCK --> APPLY["заменить старые туры блоком"]
    APPLY --> PERSIST["сохранить полную историю<br/>в session.jsonl на диск"]
    
    PERSIST --> DONE_COMPACT["готово к следующему THINK"]
    
    KEEP --> DONE_COMPACT
```

---

## 7. Детекция галлюцинаций

```mermaid
flowchart LR
    RESP["Ответ LLM"] --> PRE{
        "пустой или короткий<br/>менее 10 токенов?"
    }
    PRE -->|да| FAIL_RETRY["RETRY<br/>повторный вызов LLM"]
    PRE -->|нет| REPEAT{
        "пересечение > 50%<br/>с предыдущим ответом?"
    }
    REPEAT -->|да| FAIL_RETRY
    REPEAT -->|нет| CONFIDENCE{
        "маркеры неуверенности?<br/>(maybe, I think, probably)"
    }
    CONFIDENCE -->|да| WARN["WARN<br/>показать с ⚠️"]
    CONFIDENCE -->|нет| FACTUAL["извлечь пути/API из текста"]
    
    FACTUAL --> KNOWN{"путь есть в<br/>известном наборе?"}
    KNOWN -->|нет| FACT_WARN["WARN<br/>упомянут неизвестный путь"]
    KNOWN -->|да| CONSISTENT{"противоречит<br/>предыдущим решениям?"}
    
    CONSISTENT -->|да| CONSIST_WARN["WARN<br/>обнаружено противоречие"]
    CONSISTENT -->|нет| PASS["PASS ✓<br/>показать пользователю"]
    
    FAIL_RETRY --> RETRY_CHECK{"попыток >= 3?"}
    RETRY_CHECK -->|нет| RETRY_CTX["добавить предупреждение<br/>в контекст и повторить"]
    RETRY_CTX --> PRE
    RETRY_CHECK -->|да| BLOCK["BLOCK<br/>запросить вмешательство пользователя"]
```

---

## 8. Архитектура истории сессии

```mermaid
flowchart TD
    subgraph RUNTIME["Память (RAM)"]
        AGENT["Цикл Агента"]
        CTXMANAGER["ContextManager<br/>активное окно: 63% от contextWindow"]
        HISTORY["Буфер полной истории<br/>все сообщения сессии"]
    end
    
    subgraph DISK["Диск (~/.mma/sessions/)"]
        PROJECT["<project>/"]
        SESSION["<session-id>.jsonl"]
        ARCHIVE["<session-id>.jsonl.gz<br/>(через 30 дней)"]
    end
    
    AGENT -->|каждое сообщение| CTXMANAGER
    CTXMANAGER -->|компакшен| HISTORY
    HISTORY -->|дозапись каждого сообщения| SESSION
    SESSION -->|ротация через 30 дней| ARCHIVE
    
    AGENT -->|search_history| SEARCH["поиск по файлам сессий<br/>regex/keywords"]
    SEARCH -->|результаты| AGENT
```

---

## 9. Полный цикл агента: один раунд

```mermaid
sequenceDiagram
    box Black Ядро
        participant A as Агент
        participant PB as PromptBuilder
        participant H as HallucinationDetector
        participant TE as ToolExecutor
        participant SH as SessionHistory
    end
    box Gray Внешние
        participant M as Модули
        participant LLM as LLM API
        participant FS as Файловая система
    end

    Note over A,SH: === INIT ===
    A->>PB: сборка system prompt
    PB->>M: сбор PromptBlock[]
    M-->>PB: блоки
    PB-->>A: собранный промпт (8K)
    
    Note over A,SH: === THINK ===
    A->>SH: запись сообщения пользователя
    A->>LLM: chat(system + history)
    LLM-->>A: стриминг ответа
    A->>H: валидация(response)
    
    alt повтор
        H-->>A: проблемы обнаружены
        A->>A: добавить контекст → THINK снова
    else пройдено
        H-->>A: OK
        
        alt tool_call
            Note over A,SH: === ACT ===
            A->>TE: выполнить(call)
            TE->>FS: операция
            FS-->>TE: результат
            TE-->>A: ToolResult
            
            Note over A,SH: === OBSERVE ===
            A->>SH: запись результата
            A->>A: нужны ещё шаги? → THINK / DONE
        else текст
            A->>SH: запись ответа
            A->>A: вывод пользователю → ожидание
        end
    end
```

---

## 10. Слияние конфигурации

```mermaid
flowchart LR
    DEF["config/defaults.ts<br/>DEFAULTS"]
    GLOBAL["~/.mma/config.json<br/>глобальные переопределения"]
    PROJECT[".mmrc<br/>проектные переопределения"]
    ENV["ENV переменные<br/>MMA_*"]
    
    DEF --> MERGE1["слияние"]
    GLOBAL --> MERGE1
    MERGE1 --> MERGE2["слияние"]
    PROJECT --> MERGE2
    MERGE2 --> MERGE3["слияние"]
    ENV --> MERGE3
    MERGE3 --> FINAL["AppConfig<br/>итоговый конфиг"]
```

---

## 11. Архитектура автокомплита

```mermaid
flowchart TD
    TAB["TAB"] --> REPL["repl.ts<br/>readline completer"]
    REPL --> COMPLETER["cli/completer.ts<br/>Completer"]
    
    COMPLETER --> MATCH["поиск подходящего провайдера"]
    
    MATCH --> PROV1{"tokenIndex = 0<br/>&& начинается с /?"}
    PROV1 -->|да| SLASH["SlashCommandProvider<br/>→ help, model, config, ..."]
    
    PROV1 -->|нет| PROV2{"tokenIndex = 1?"}
    PROV2 -->|/model| MODEL["ModelArgProvider<br/>→ qwen3.5-9b, llama-3.2, ..."]
    PROV2 -->|/config| CONFIG["ConfigKeyProvider<br/>→ model, locale, logLevel, ..."]
    PROV2 -->|/provider| PROV["ProviderArgProvider<br/>→ openai-compat, ..."]
    
    PROV2 -->|нет| PROV3{"есть / или \ в<br/>текущем токене?"}
    PROV3 -->|да| FILE["FilePathProvider<br/>→ src/, docs/, ..."]
    PROV3 -->|нет| EMPTY["нет вариантов"]
    
    SLASH --> RESULT["completions[]"]
    MODEL --> RESULT
    CONFIG --> RESULT
    PROV --> RESULT
    FILE --> RESULT
    EMPTY --> RESULT
    
    RESULT --> REPL
    REPL --> USER["показать пользователю"]
```

---

## 12. Task Execution Pipeline

```mermaid
flowchart TD
    USER["Пользователь:<br/>\"реализуй OAuth\""] --> INTENT["core/agent.ts<br/>получен запрос"]
    INTENT --> HEURISTIC{"multi-step?<br/>> 1 файла или слов > 10?"}
    
    HEURISTIC -->|простой| SINGLE["выполнить напрямую<br/>без плана"]
    HEURISTIC -->|комплексный| ENFORCE["system: принудительно<br/>создать план"]
    
    ENFORCE --> ORCH{"есть orchestrator.model<br/>в конфиге?"}
    ORCH -->|да| ORCH_PLAN["orchestrator<br/>chat → plan create"]
    ORCH -->|нет| WORKER_PLAN["рабочая модель (9B)<br/>chat → plan create"]
    
    ORCH_PLAN --> SAVE["план сохранён"]
    WORKER_PLAN --> SAVE
    
    SAVE --> SHOW_USER["вывод прогресса пользователю<br/>[Plan] 0/5 ░░░░░  0%"]
    SHOW_USER --> INSERT["вставить план в system prompt"]
    INSERT
    
    INSERT --> SYSPROMPT["[Plan: implement-oauth] (выполнено: 0/5)"]
    SYSPROMPT --> TOOL["model вызывает tool<br/>plan update step1 done"]
    
    TOOL --> TRACKER["execution/tracker.ts<br/>обновить статус"]
    TRACKER --> VERIFIER["execution/verifier.ts<br/>проверить шаг"]
    
    VERIFIER --> VERIFY{"проверка пройдена?"}
    VERIFY -->|да| NEXT_STEP["[x] шаг готов<br/>перейти к следующему"]
    VERIFY -->|нет| RETRY_LOG["execution/stuck-detector.ts<br/>логировать ошибку"]
    
    RETRY_LOG --> RETRY{"< 3 попыток?"}
    RETRY -->|да| TOOL_RETRY["retry с контекстом<br/>предыдущей ошибки"]
    RETRY -->|нет| ASK_USER["question:<br/>пропустить/отменить?"]
    ASK_USER -->|пропустить| NEXT_STEP
    ASK_USER -->|отменить| ABORT["задача отменена"]
    
    NEXT_STEP --> AUDITOR{"все шаги готовы?"}
    AUDITOR -->|нет| SYSPROMPT
    AUDITOR -->|да| AUDIT["execution/auditor.ts<br/>финальная проверка"]
    
    AUDIT --> FILES_OK{"все файлы<br/>существуют?"}
    FILES_OK -->|нет| FIX["добавить шаг<br/>создать недостающие файлы"]
    FIX --> SYSPROMPT
    FILES_OK -->|да| TESTS{"запустить тесты?"}
    TESTS -->|есть тесты| RUN_TEST["bun test"]
    RUN_TEST --> TEST_OK{"проходят?"}
    TEST_OK -->|да| DONE["✓ задача выполнена<br/>показать пользователю"]
    TEST_OK -->|нет| FIX_TEST["новый шаг:<br/>починить тесты"]
    FIX_TEST --> SYSPROMPT
    TESTS -->|нет тестов| DONE
    
    style ABORT fill:#ffcccc
    style DONE fill:#ccffcc
```

## 13. Диаграмма зависимостей пакетов

```mermaid
graph TB
    subgraph CLI
        MAIN["cli/main.ts"]
        CMD["cli/commands.ts"]
        REPL["cli/repl.ts"]
        COMP["cli/completer.ts"]
        SETUP["cli/setup.ts"]
    end
    
    subgraph CORE
        AGENT["core/agent.ts"]
        PB["core/prompt-builder.ts"]
    end
    
    subgraph LLM
        PROV["llm/provider.ts"]
        OAI["llm/openai-compat.ts"]
        TIK["llm/token-counter.ts"]
        RESP["llm/response.ts"]
        ORCH["llm/orchestrator.ts"]
    end
    
    ORCH --> PROV
    
    subgraph TOOLS
        REG["tools/registry.ts"]
        EXEC["tools/executor.ts"]
        BASH["tools/bash.ts"]
        FS_TOOLS["tools/read-file.ts<br/>tools/write-file.ts<br/>tools/edit-file.ts<br/>..."]
        SUB["tools/subagent.ts"]
    end
    
    subgraph MOD
        SK["modules/skills/"]
        PL["modules/plugins/"]
        MCP["modules/mcp/"]
        PIP["modules/pipelines/"]
        IDX["modules/indexer/"]
        MEM["modules/memory/"]
        UP["modules/user-profile/"]
        CCTX["modules/context/"]
        HAL["modules/hallucination/"]
        UPD["modules/updater/"]
        EXECMOD["modules/execution/"]
    end
    
    MAIN --> CMD
    MAIN --> REPL
    MAIN --> SETUP
    REPL --> COMP
    
    CMD --> AGENT
    REPL --> AGENT
    SETUP --> CONFIG["config/"]
    
    AGENT --> PB
    AGENT --> PROV
    AGENT --> ORCH
    AGENT --> REG
    AGENT --> EXEC
    AGENT --> MOD
    AGENT --> EXECMOD
    AGENT --> H["core/hallucination.ts"]
    
    EXECMOD --> ORCH
    
    PB --> MOD
    
    EXEC --> REG
    EXEC --> PL
    
    SUB --> AGENT
    BASH --> EXEC
    FS_TOOLS --> EXEC
    
    OAI --> PROV
    TIK --> PROV
    RESP --> PROV
```
