# Локальные квантованные модели: рекомендованный стенд

Спека: [2026-11-22-local-model-harness-fit-design.md](../specs/2026-11-22-local-model-harness-fit-design.md).
Модель не правится — настраивается сервер и харнесс.

## 1. Reasoning: non-thinking для agent-циклов

У Qwen3/3.5/3.8 нативное управление — **бинарное** (`enable_thinking`), а не шкала
`none/minimal/low/high`. Уровни MMA — маппинг харнесса; llama.cpp часто его игнорирует
(`mechanism IGNORED`), и `reasoning:"minimal"` ломает запрос. LM‑1/2 теперь клампят
неподдерживаемый уровень в `undefined` и пишут `reasoning_degraded`.

Рекомендуется выставить режим **на сервере**:
```
llama-server -m <model>.gguf -c 131072 -ngl all -ctk q8_0 -ctv q8_0 -fa on -np 1 \
  --chat-template-kwargs '{"enable_thinking":false}' \
  --temp 0.7 --top-p 0.8 --top-k 20
```
Для редких сложных задач держите второй вариант через llama-swap:
`Qwen-Think` (temp 0.6 / top_p 0.95) и `Qwen-NoThink` (temp 0.7 / top_p 0.8).

## 2. Квант и tool calling

- Q4_K_M — минимум; ниже Q4 tool calling и JSON-схемы становятся ненадёжными.
- Dynamic quants (UD-Q4_K_XL) теряют <1 п.п. качества, но проверьте chat-template
  совместимость с llama.cpp (build **b8121+**) — иначе режим мышления «откатывается».
- Галлюцинации/бесконечный повтор часто лечатся `-ctk q8_0 -ctv q8_0`.
- Per-model tool-call parser обязателен: vLLM `--tool-call-parser qwen3_coder`,
  SGLang `--tool-call-parser ...`. LM‑4 пишет `tool_degraded` с этим советом после
  3 отказов — вините харнесс, а не модель.

## 3. Политика shell

`execution.profile=local-trusted` теперь означает разрешительную bash-политику
(LM‑3): операторы `>`, `|`, `&&` и интерпретаторы `node/python` разрешены, hard-deny
остаётся за деструктивным (`rm -rf`, `dd`, `sudo`, …). Явная настройка
`security.bash.dangerousOperators/blacklist` уважается. `sandbox` не меняется.

Пример для стенда: `mma web` + `MMA_CONFIG_DIR=<isolated>` и профиль `local-trusted`.

## Источники

- Qwen3 blog (hybrid thinking, /think и /no_think): https://qwenlm.github.io/blog/qwen3/
- llama.cpp #13160 (`enable_thinking` ignored), #13427 (`/no_think` slowdown)
- OpenCode permissions (allow/ask/deny, default allow): https://opencode.ai/docs/permissions/
