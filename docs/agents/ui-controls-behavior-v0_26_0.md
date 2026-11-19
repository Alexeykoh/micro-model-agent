# Поведенческая проверка всех контролов mma web (v0.26.0)

Отчёт фиксирует результат нажатия/изменения каждого найденного интерактивного элемента живой страницы mma web. В отличие от первого отчёта, здесь проверяется не «записалось ли значение», а «произошло ли видимое действие».

- Стенд: `mma-web-test`, `http://127.0.0.1:7334/?token=docker-test-hamachi-2026`.
- Модель для живых прогонов: `llama.cpp / deepseek-v4-pro-9b`.
- Дата: 2026-11-19.

## Итог

| Статус | Контролов |
| --- | ---: |
| WORKS | 710 |
| INERT | 24 |
| **Всего уникальных** | **734** |

**WORKS** — после действия зафиксировано наблюдаемое изменение: DOM (появление/скрытие панели, смена aria-атрибутов), конфиг в `GET /api/config`, буфер обмена, счётчик сообщений/вкладок, URL, фокус или значение поля. Пример доказательства хранится в колонке «Наблюдаемый эффект».

## Методика

1. Снималось состояние до действия: подпись видимых интерактивных элементов, JSON конфига, URL, число сообщений и вкладок, счётчик записей в буфер обмена, текст тоста, активный элемент и значения полей.
2. Для каждого элемента выполнялось действие по его типу: `click` для кнопок и `role=switch`, `change` для `select`/`input[number]`/`input[text]`, `input` для `textarea`, Enter для полей поиска. Для чипов тегов после проверки элемент возвращался в исходное состояние через UI.
3. Снималось состояние после действия и вычислялась разница. Непустая разница = WORKS с указанием, именно что изменилось.
4. Состояния: основная страница, четыре меню селекторов, список сессий, панель инструментов, раскрытые «думаю», сайдбар (включая скрытые вкладки), 15 панелей настроек и их подвкладки. Одинаковые контролы в разных состояниях дедуплицируются.
5. Деструктивные действия (удаление сессии) проверялись до появления диалога подтверждения и отменялись.

## Наблюдения

- Кнопки, уже находящиеся в целевом состоянии (активная вкладка `dark`, активная тема `console`, `Файлы` при открытой панели), дают «нет наблюдаемого изменения» — это ожидаемый no-op, а не отказ.
- Информационные бейджи DLP и индикаторы возможностей модели в ряде состояний не меняют DOM при клике; их рабочее состояние подтверждено на основной странице.
- Значения ниже `min` ("сетевой таймаут" = 17 мс при `min=1000`) корректно отклоняются валидацией — тест с 17000 мс прошёл.
- Кнопка «прикрепить изображение» открывает системный файл-диалог; проверено наличие скрытого `input[type=file]`. Сам диалог ОС в headless-браузере не эмулируется.
- Часть «нет наблюдаемого изменения» у кнопок `Re-index`, `перезагрузить плагины`, `filesCollapseAll`, `filesRefresh` объясняется асинхронной/отложенной реакцией без немедленного DOM-эффекта в момент замера.

## Проверенные контролы

| Контрол | Статус | Действие | Наблюдаемый эффект | Состояния |
| --- | --- | --- | --- | --- |
| - | WORKS | click | config, field values | set-ui |
| ↺черновик отозван: аудит планапоказать | WORKS | click | DOM | main, sidebar-more, set-general |
| ↺черновик отозван: аудит планаскрыть | WORKS | click | DOM | menu-provider, menu-model, menu-context |
| ↺черновик отозван: аудит планаhide | WORKS | click | DOM | set-agent, set-agent::Инструменты, set-security::Shell и пути |
| ↺черновик отозван: аудит планаshow | WORKS | click | DOM | set-model, set-agent::Эксперты, set-security::Обзор |
| ↺черновик отозван: критикпоказать | WORKS | click | DOM | main, sidebar-more, set-general |
| ↺черновик отозван: критикскрыть | WORKS | click | DOM | menu-provider, menu-model, menu-context |
| ↺черновик отозван: критикhide | WORKS | click | DOM | set-agent, set-agent::Инструменты, set-security::Shell и пути |
| ↺черновик отозван: критикshow | WORKS | click | DOM | set-model, set-agent::Эксперты, set-security::Обзор |
| + | WORKS | click | field values | set-ui |
| ◇критик · замечание · проходов 2 · 33.3 sпоказать | WORKS | click | DOM | set-model, set-service |
| ◇критик · замечание · проходов 2 · 33.3 sскрыть | WORKS | click | DOM | sidebar-Файлы, set-ui |
| ◇критик · ок · проходов 1 · 10.5 sпоказать | WORKS | click | DOM | set-service |
| ◇критик · ок · проходов 1 · 10.5 sскрыть | WORKS | click | DOM | set-ui |
| ◇критик · ок · проходов 1 · 10.9 sпоказать | WORKS | click | DOM | set-service |
| ◇критик · ок · проходов 1 · 10.9 sскрыть | WORKS | click | DOM | set-ui |
| ◇критик · ок · проходов 1 · 14.5 sпоказать | WORKS | click | DOM | set-general |
| ◇критик · ок · проходов 1 · 14.5 sскрыть | WORKS | click | DOM | set-general |
| ◇критик · ок · проходов 1 · 14.5 shide | WORKS | click | DOM | set-agent, set-agent::Инструменты, set-security::Shell и пути |
| ◇критик · ок · проходов 1 · 14.5 sshow | WORKS | click | DOM | set-model, set-agent::Эксперты, set-security::Обзор |
| ◇критик · ок · проходов 1 · 14.7 sпоказать | WORKS | click | DOM | sidebar-more, set-general |
| ◇критик · ок · проходов 1 · 14.7 sскрыть | WORKS | click | DOM | set-general |
| ◇критик · ок · проходов 1 · 14.7 shide | WORKS | click | DOM | set-model, set-agent::Эксперты, set-security::Обзор |
| ◇критик · ок · проходов 1 · 14.7 sshow | WORKS | click | DOM | set-agent, set-agent::Инструменты, set-security::Shell и пути |
| ◇критик · ок · проходов 1 · 15.5 sпоказать | WORKS | click | DOM | set-general |
| ◇критик · ок · проходов 1 · 15.5 sскрыть | WORKS | click | DOM | set-general |
| ◇критик · ок · проходов 1 · 15.5 shide | WORKS | click | DOM | set-agent, set-agent::Инструменты, set-security::Shell и пути |
| ◇критик · ок · проходов 1 · 15.5 sshow | WORKS | click | DOM | set-model, set-agent::Эксперты, set-security::Обзор |
| ◇критик · ок · проходов 1 · 2.8 sпоказать | WORKS | click | DOM | set-ui |
| ◇критик · ок · проходов 1 · 4.6 sпоказать | WORKS | click | DOM | sidebar-more, set-general |
| ◇критик · ок · проходов 1 · 4.6 sскрыть | WORKS | click | DOM | set-general |
| ◇критик · ок · проходов 1 · 4.6 shide | WORKS | click | DOM | set-model, set-agent::Эксперты, set-security::Обзор |
| ◇критик · ок · проходов 1 · 4.6 sshow | WORKS | click | DOM | set-agent, set-agent::Инструменты, set-security::Shell и пути |
| ◇критик · ок · проходов 1 · 5.3 sпоказать | WORKS | click | DOM | sidebar-more, set-general |
| ◇критик · ок · проходов 1 · 5.3 sскрыть | WORKS | click | DOM | set-general |
| ◇критик · ок · проходов 1 · 5.3 shide | WORKS | click | DOM | set-model, set-agent::Эксперты, set-security::Обзор |
| ◇критик · ок · проходов 1 · 5.3 sshow | WORKS | click | DOM | set-agent, set-agent::Инструменты, set-security::Shell и пути |
| ◇критик · ок · проходов 1 · 8.0 sпоказать | WORKS | click | DOM | set-general |
| ◇критик · ок · проходов 1 · 8.0 shide | WORKS | click | DOM | set-model, set-agent::Эксперты, set-security::Обзор |
| ◇критик · ок · проходов 1 · 8.0 sshow | WORKS | click | DOM | set-agent, set-agent::Инструменты, set-security::Shell и пути |
| ◇verifier · critical · 2 pass(es) · 15.9 shide | WORKS | click | DOM | set-plugins::Плагины |
| ◇verifier · critical · 2 pass(es) · 15.9 sshow | WORKS | click | DOM | set-agent::Эксперты |
| ◇verifier · critical · 2 pass(es) · 17.0 sshow | WORKS | click | DOM | set-plugins::Плагины |
| ◇verifier · critical · 2 pass(es) · 19.9 shide | WORKS | click | DOM | set-ui, set-security::Shell и пути, set-agent::Эксперты |
| ◇verifier · critical · 2 pass(es) · 19.9 sshow | WORKS | click | DOM | set-plugins::Плагины, set-advanced, set-agent::Критик |
| ◇verifier · critical · 2 pass(es) · 21.6 shide | WORKS | click | DOM | set-agent::Инструменты, set-security::Shell и пути, set-plugins::Плагины |
| ◇verifier · critical · 2 pass(es) · 21.6 sshow | WORKS | click | DOM | set-agent::Эксперты, set-security::Обзор, set-security::Аудит |
| ◇verifier · critical · 2 pass(es) · 24.2 sshow | WORKS | click | DOM | set-plugins::Плагины |
| ◇verifier · ok · 1 pass(es) · 13.2 shide | WORKS | click | DOM | set-security::Аудит, set-ui, set-security::Shell и пути |
| ◇verifier · ok · 1 pass(es) · 13.2 sshow | WORKS | click | DOM | set-security::Shell и пути, set-plugins::Плагины, set-advanced |
| ◇verifier · ok · 1 pass(es) · 2.8 shide | WORKS | click | DOM | set-plugins::Плагины, set-advanced, set-agent::Критик |
| ◇verifier · ok · 1 pass(es) · 2.8 sshow | WORKS | click | DOM | set-security::Аудит, set-ui, set-security::Shell и пути |
| ◇verifier · ok · 1 pass(es) · 4.5 shide | WORKS | click | DOM | set-security::Обзор, set-security::Аудит, set-ui |
| ◇verifier · ok · 1 pass(es) · 4.5 sshow | WORKS | click | DOM | set-agent::Инструменты, set-security::Shell и пути, set-plugins::Плагины |
| ◇verifier · ok · 1 pass(es) · 5.0 shide | WORKS | click | DOM | set-security::Обзор, set-security::Аудит, set-ui |
| ◇verifier · ok · 1 pass(es) · 5.0 sshow | WORKS | click | DOM | set-agent::Инструменты, set-security::Shell и пути, set-plugins::Плагины |
| ◇verifier · ok · 1 pass(es) · 5.1 shide | WORKS | click | DOM | set-advanced, set-agent::Критик, set-plugins::Плагины |
| ◇verifier · ok · 1 pass(es) · 5.1 sshow | WORKS | click | DOM | set-ui, set-security::Shell и пути, set-agent::Эксперты |
| ◇verifier · ok · 1 pass(es) · 5.5 shide | WORKS | click | DOM | set-agent::Критик, set-plugins::Плагины |
| ◇verifier · ok · 1 pass(es) · 5.5 sshow | WORKS | click | DOM | set-security::Shell и пути, set-agent::Эксперты |
| ◇verifier · ok · 1 pass(es) · 6.0 shide | WORKS | click | DOM | set-security::Shell и пути, set-plugins::Плагины, set-advanced |
| ◇verifier · ok · 1 pass(es) · 6.0 sshow | WORKS | click | DOM | set-security::Обзор, set-security::Аудит, set-ui |
| ◇verifier · ok · 1 pass(es) · 7.0 shide | WORKS | click | DOM | set-advanced, set-agent::Критик, set-plugins::Плагины |
| ◇verifier · ok · 1 pass(es) · 7.0 sshow | WORKS | click | DOM | set-ui, set-security::Shell и пути, set-agent::Эксперты |
| ◇verifier · ok · 1 pass(es) · 8.0 shide | WORKS | click | DOM | set-agent::Эксперты, set-security::Обзор, set-security::Аудит |
| ◇verifier · ok · 1 pass(es) · 8.0 sshow | WORKS | click | DOM | set-agent, set-agent::Инструменты, set-security::Shell и пути |
| ◇verifier · ok · 1 pass(es) · 8.1 shide | WORKS | click | DOM | set-agent::Эксперты |
| ◇verifier · ok · 1 pass(es) · 8.1 sshow | WORKS | click | DOM | set-agent::Критик, set-plugins::Плагины |
| ◇verifier · ok · 1 pass(es) · 8.3 shide | WORKS | click | DOM | set-agent, set-agent::Инструменты, set-security::Shell и пути |
| ◇verifier · ok · 1 pass(es) · 8.3 sshow | WORKS | click | DOM | set-model, set-agent::Эксперты, set-security::Обзор |
| ✦думаюпоказать | WORKS | click | DOM | main, menu-provider, menu-model |
| ✦думаюскрыть | WORKS | click | DOM | menu-provider, menu-model, menu-context |
| ✦думаюdefault· 0.6sпоказать | WORKS | click | DOM | set-agent::Эксперты, set-model, set-service |
| ✦думаюdefault· 0.6sскрыть | WORKS | click | DOM | set-plugins::Плагины, sidebar-Файлы, set-ui |
| ✦думаюdefault· 1.0sпоказать | WORKS | click | DOM | set-agent::Критик, set-plugins::Плагины, sidebar-Файлы |
| ✦думаюdefault· 1.0sскрыть | WORKS | click | DOM | set-agent::Эксперты, set-model, set-service |
| ✦думаюdefault· 1.4sпоказать | WORKS | click | DOM | set-agent::Критик, set-plugins::Плагины, sidebar-Файлы |
| ✦думаюdefault· 1.4sскрыть | WORKS | click | DOM | set-agent::Эксперты, set-model, set-service |
| ✦думаюdefault· 1.5sпоказать | WORKS | click | DOM | set-agent::Критик, set-plugins::Плагины, sidebar-Файлы |
| ✦думаюdefault· 1.5sскрыть | WORKS | click | DOM | set-agent::Эксперты, set-model, set-service |
| ✦думаюdefault· 1.8sпоказать | WORKS | click | DOM | set-agent::Эксперты, set-model, set-service |
| ✦думаюdefault· 1.8sскрыть | WORKS | click | DOM | set-plugins::Плагины, sidebar-Файлы, set-ui |
| ✦думаюdefault· 1.9sпоказать | WORKS | click | DOM | set-plugins::Плагины, sidebar-Файлы, set-ui |
| ✦думаюdefault· 1.9sскрыть | WORKS | click | DOM | set-model, set-service |
| ✦думаюdefault· 14.0sпоказать | WORKS | click | DOM | set-service |
| ✦думаюdefault· 15.0sскрыть | WORKS | click | DOM | set-ui |
| ✦думаюdefault· 16.1sпоказать | WORKS | click | DOM | set-general |
| ✦думаюdefault· 16.1sскрыть | WORKS | click | DOM | set-general |
| ✦думаюdefault· 16.1shide | WORKS | click | DOM | set-agent, set-agent::Инструменты, set-security::Shell и пути |
| ✦думаюdefault· 16.1sshow | WORKS | click | DOM | set-model, set-agent::Эксперты, set-security::Обзор |
| ✦думаюdefault· 16.8sпоказать | WORKS | click | DOM | set-general |
| ✦думаюdefault· 16.8sскрыть | WORKS | click | DOM | set-general |
| ✦думаюdefault· 16.8shide | WORKS | click | DOM | set-agent, set-agent::Инструменты, set-security::Shell и пути |
| ✦думаюdefault· 16.8sshow | WORKS | click | DOM | set-model, set-agent::Эксперты, set-security::Обзор |
| ✦думаюdefault· 17.2sпоказать | WORKS | click | DOM | set-model, set-service |
| ✦думаюdefault· 17.2sскрыть | WORKS | click | DOM | sidebar-Файлы, set-ui |
| ✦думаюdefault· 17.3sпоказать | WORKS | click | DOM | sidebar-more, set-general |
| ✦думаюdefault· 17.3sскрыть | WORKS | click | DOM | set-general |
| ✦думаюdefault· 17.3shide | WORKS | click | DOM | set-model, set-agent::Эксперты, set-security::Обзор |
| ✦думаюdefault· 17.3sshow | WORKS | click | DOM | set-agent, set-agent::Инструменты, set-security::Shell и пути |
| ✦думаюdefault· 17.5sпоказать | WORKS | click | DOM | set-plugins::Плагины, set-ui |
| ✦думаюdefault· 17.5sскрыть | WORKS | click | DOM | set-service |
| ✦думаюdefault· 2.1sпоказать | WORKS | click | DOM | set-plugins::Плагины, sidebar-Файлы, set-ui |
| ✦думаюdefault· 2.1sскрыть | WORKS | click | DOM | set-model, set-service |
| ✦думаюdefault· 2.3sпоказать | WORKS | click | DOM | set-agent::Критик, set-plugins::Плагины, sidebar-Файлы |
| ✦думаюdefault· 2.3sскрыть | WORKS | click | DOM | set-agent::Эксперты, set-model, set-service |
| ✦думаюdefault· 2.4sпоказать | WORKS | click | DOM | set-agent::Критик, set-plugins::Плагины, sidebar-Файлы |
| ✦думаюdefault· 2.4sскрыть | WORKS | click | DOM | set-agent::Эксперты, set-model, set-service |
| ✦думаюdefault· 2.5sпоказать | WORKS | click | DOM | set-agent::Критик, set-plugins::Плагины, sidebar-Файлы |
| ✦думаюdefault· 2.5sскрыть | WORKS | click | DOM | set-agent::Эксперты, set-model, set-service |
| ✦думаюdefault· 21.2sпоказать | WORKS | click | DOM | set-general |
| ✦думаюdefault· 21.2sскрыть | WORKS | click | DOM | set-general |
| ✦думаюdefault· 21.2shide | WORKS | click | DOM | set-agent, set-agent::Инструменты, set-security::Shell и пути |
| ✦думаюdefault· 21.2sshow | WORKS | click | DOM | set-model, set-agent::Эксперты, set-security::Обзор |
| ✦думаюdefault· 22.9sпоказать | WORKS | click | DOM | set-general |
| ✦думаюdefault· 22.9sскрыть | WORKS | click | DOM | set-general |
| ✦думаюdefault· 22.9shide | WORKS | click | DOM | set-agent, set-agent::Инструменты, set-security::Shell и пути |
| ✦думаюdefault· 22.9sshow | WORKS | click | DOM | set-model, set-agent::Эксперты, set-security::Обзор |
| ✦думаюdefault· 23.6sпоказать | WORKS | click | DOM | sidebar-more, set-general |
| ✦думаюdefault· 23.6sскрыть | WORKS | click | DOM | set-general |
| ✦думаюdefault· 23.6shide | WORKS | click | DOM | set-model, set-agent::Эксперты, set-security::Обзор |
| ✦думаюdefault· 23.6sshow | WORKS | click | DOM | set-agent, set-agent::Инструменты, set-security::Shell и пути |
| ✦думаюdefault· 3.0sпоказать | WORKS | click | DOM | set-plugins::Плагины, sidebar-Файлы, set-ui |
| ✦думаюdefault· 3.0sскрыть | WORKS | click | DOM | set-model, set-service |
| ✦думаюdefault· 3.7sпоказать | WORKS | click | DOM | set-agent::Эксперты, set-model, set-service |
| ✦думаюdefault· 3.7sскрыть | WORKS | click | DOM | set-plugins::Плагины, sidebar-Файлы, set-ui |
| ✦думаюdefault· 4.1sпоказать | WORKS | click | DOM | set-plugins::Плагины, sidebar-Файлы, set-ui |
| ✦думаюdefault· 4.1sскрыть | WORKS | click | DOM | set-model, set-service |
| ✦думаюdefault· 4.5sпоказать | WORKS | click | DOM | set-plugins::Плагины, sidebar-Файлы, set-ui |
| ✦думаюdefault· 4.5sскрыть | WORKS | click | DOM | set-model, set-service |
| ✦думаюdefault· 40.8sпоказать | WORKS | click | DOM | sidebar-Файлы, set-ui |
| ✦думаюdefault· 40.8sскрыть | WORKS | click | DOM | set-model, set-service |
| ✦думаюdefault· 5.2sпоказать | WORKS | click | DOM | set-model, set-service |
| ✦думаюdefault· 5.2sскрыть | WORKS | click | DOM | sidebar-Файлы, set-ui |
| ✦думаюdefault· 5.6sпоказать | WORKS | click | DOM | set-agent::Критик, set-agent::Эксперты, set-plugins::Плагины |
| ✦думаюdefault· 5.6sскрыть | WORKS | click | DOM | set-agent::Эксперты, set-plugins::Плагины, set-model |
| ✦думаюdefault· 6.4sпоказать | WORKS | click | DOM | sidebar-more, set-general |
| ✦думаюdefault· 6.4sскрыть | WORKS | click | DOM | set-general |
| ✦думаюdefault· 6.4shide | WORKS | click | DOM | set-model, set-agent::Эксперты, set-security::Обзор |
| ✦думаюdefault· 6.4sshow | WORKS | click | DOM | set-agent, set-agent::Инструменты, set-security::Shell и пути |
| ✦думаюdefault· 6.9sпоказать | WORKS | click | DOM | sidebar-more, set-general |
| ✦думаюdefault· 6.9sскрыть | WORKS | click | DOM | set-general |
| ✦думаюdefault· 6.9shide | WORKS | click | DOM | set-model, set-agent::Эксперты, set-security::Обзор |
| ✦думаюdefault· 6.9sshow | WORKS | click | DOM | set-agent, set-agent::Инструменты, set-security::Shell и пути |
| ✦думаюdefault· 7.2sпоказать | WORKS | click | DOM | set-ui |
| ✦думаюdefault· 7.3sпоказать | WORKS | click | DOM | sidebar-Файлы |
| ✦думаюdefault· 9.6sпоказать | WORKS | click | DOM | set-general |
| ✦думаюdefault· 9.6shide | WORKS | click | DOM | set-model, set-agent::Эксперты, set-security::Обзор |
| ✦думаюdefault· 9.6sshow | WORKS | click | DOM | set-agent, set-agent::Инструменты, set-security::Shell и пути |
| ✦думаюhide | WORKS | click | DOM | set-model, set-agent, set-agent::Эксперты |
| ✦думаюshow | WORKS | click | DOM | set-model, set-agent, set-agent::Эксперты |
| ✦thinkingdefault· 10.5shide | WORKS | click | DOM | set-agent::Эксперты |
| ✦thinkingdefault· 10.5sshow | WORKS | click | DOM | set-agent::Критик, set-plugins::Плагины |
| ✦thinkingdefault· 11.8shide | WORKS | click | DOM | set-advanced, set-agent::Критик, set-plugins::Плагины |
| ✦thinkingdefault· 11.8sshow | WORKS | click | DOM | set-ui, set-security::Shell и пути, set-agent::Эксперты |
| ✦thinkingdefault· 16.4shide | WORKS | click | DOM | set-security::Аудит, set-ui, set-security::Shell и пути |
| ✦thinkingdefault· 16.4sshow | WORKS | click | DOM | set-security::Shell и пути, set-plugins::Плагины, set-advanced |
| ✦thinkingdefault· 24.3sshow | WORKS | click | DOM | set-agent::Эксперты |
| ✦thinkingdefault· 27.3sshow | WORKS | click | DOM | set-plugins::Плагины, set-agent::Эксперты |
| ✦thinkingdefault· 3.3shide | WORKS | click | DOM | set-plugins::Плагины, set-advanced, set-agent::Критик |
| ✦thinkingdefault· 3.3sshow | WORKS | click | DOM | set-security::Аудит, set-ui, set-security::Shell и пути |
| ✦thinkingdefault· 33.0sshow | WORKS | click | DOM | set-plugins::Плагины |
| ✦thinkingdefault· 33.1shide | WORKS | click | DOM | set-agent::Инструменты, set-security::Shell и пути, set-plugins::Плагины |
| ✦thinkingdefault· 33.1sshow | WORKS | click | DOM | set-security::Обзор, set-security::Аудит, set-ui |
| ✦thinkingdefault· 34.2shide | WORKS | click | DOM | set-ui, set-security::Shell и пути, set-agent::Эксперты |
| ✦thinkingdefault· 34.2sshow | WORKS | click | DOM | set-advanced, set-agent::Критик, set-plugins::Плагины |
| ✦thinkingdefault· 45.8shide | WORKS | click | DOM | set-plugins::Плагины |
| ✦thinkingdefault· 6.7shide | WORKS | click | DOM | set-security::Обзор, set-security::Shell и пути, set-security::Аудит |
| ✦thinkingdefault· 6.7sshow | WORKS | click | DOM | set-agent::Инструменты, set-security::Обзор, set-security::Shell и пути |
| ✦thinkingdefault· 7.2shide | WORKS | click | DOM | set-agent::Критик, set-plugins::Плагины |
| ✦thinkingdefault· 7.2sshow | WORKS | click | DOM | set-security::Shell и пути, set-agent::Эксперты |
| ✦thinkingdefault· 7.4shide | WORKS | click | DOM | set-security::Shell и пути, set-agent::Эксперты |
| ✦thinkingdefault· 7.4sshow | WORKS | click | DOM | set-advanced, set-agent::Критик, set-plugins::Плагины |
| ✦thinkingdefault· 9.4shide | WORKS | click | DOM | set-agent, set-agent::Инструменты, set-security::Shell и пути |
| ✦thinkingdefault· 9.4sshow | WORKS | click | DOM | set-model, set-agent::Эксперты, set-security::Обзор |
| ✦thinkingdefault· 9.6shide | WORKS | click | DOM | set-agent::Эксперты, set-security::Обзор, set-security::Аудит |
| ✦thinkingdefault· 9.6sshow | WORKS | click | DOM | set-agent, set-agent::Инструменты, set-security::Shell и пути |
| 1. Исправить ошибки компиляции (mover.test.ts, mai | WORKS | click | DOM | set-agent::Критик |
| 128K | WORKS | click | DOM, config | menu-context |
| 16K | WORKS | click | DOM, config | menu-context |
| 2. Запустить и протестировать игру | INERT | click | element not visible after prepare | set-agent::Критик |
| 3. Продолжить разработку (фаза 2+) | INERT | click | element not visible after prepare | set-agent::Критик |
| 32K | WORKS | click | DOM, config | menu-context |
| 4. Другая задача | INERT | click | element not visible after prepare | set-agent::Критик |
| 5. свой ответ… | INERT | click | element not visible after prepare | set-agent::Критик |
| 64K | WORKS | click | DOM, config | menu-context |
| 8K | WORKS | click | DOM, config | menu-context |
| адрес привязки сервиса | WORKS | fill:probe-text | config, field values | set-service |
| адрес SearXNG | WORKS | fill:probe-text | config, field values | set-network |
| Аудит | WORKS | click | DOM, field values | set-security::Обзор, set-security::Аудит, set-security::Shell и пути |
| базовая задержка повтора | WORKS | fill:7 | config, field values | set-advanced |
| базовые рассуждения | WORKS | select:minimal | config, field values | set-reasoning |
| Безопасность | WORKS | click | DOM | menu-provider, menu-model, menu-context |
| белый список bash | WORKS | fill:probe-text | field values | set-security::Shell и пути |
| белый список bash: add | WORKS | click | DOM, focus BODY->белый список bash, field values | set-security::Shell и пути |
| белый список bash: remove probe-text-41183 | WORKS | click | DOM, config | set-security::Shell и пути |
| блок наружу | WORKS | fill:probe-text | field values | set-security::DLP |
| блок наружу: add | WORKS | click | config, field values | set-security::DLP |
| бумага | WORKS | click | DOM, config | set-ui |
| бюджет токенов карты | WORKS | fill:7 | field values | set-context |
| бюджет токенов критика | WORKS | fill:7 | field values | set-agent, set-agent::Критик |
| бюджет хода, USD | WORKS | fill:7 | config, field values | set-general |
| весна | WORKS | click | DOM, config | set-ui |
| видео | WORKS | click | DOM | main, menu-provider, menu-model |
| включить плагин | WORKS | click | DOM, config | set-plugins::Плагины |
| внешние 1 | WORKS | click | DOM | set-skills |
| Возможности | WORKS | click | DOM, field values | set-model |
| все 23 | INERT | click | no observable change | set-memory |
| все 4 | INERT | click | no observable change | set-skills |
| все 52 | WORKS | click | DOM | tools |
| встроенные 3 | WORKS | click | DOM | set-skills |
| выбрать сессию | WORKS | click | URL session ses_mwmeoln9... -> ses_mwnayy7s... | manual |
| выключенные плагины | WORKS | fill:probe-text | field values | set-advanced |
| выключенные плагины: add | WORKS | click | DOM, config, field values | set-advanced |
| выключенные плагины: remove angular11 | WORKS | click | DOM, config | set-advanced |
| выключенные плагины: remove telegram-notify | INERT | click | element not visible after prepare | set-advanced |
| выключить плагин | WORKS | click | DOM, config | set-plugins::Плагины |
| Выключить append_file | WORKS | click | DOM | tools |
| Выключить approve | WORKS | click | DOM | tools |
| Выключить attach_image | WORKS | click | DOM | tools |
| Выключить bash | WORKS | click | DOM | tools |
| Выключить browser | WORKS | click | DOM | tools |
| Выключить chunk_query | WORKS | click | DOM | tools |
| Выключить create_dir | WORKS | click | DOM | tools |
| Выключить define_capability | WORKS | click | DOM | tools |
| Выключить delete_file | WORKS | click | DOM | tools |
| Выключить document_find | WORKS | click | DOM | tools |
| Выключить document_index | WORKS | click | DOM | tools |
| Выключить document_map | WORKS | click | DOM | tools |
| Выключить document_read | WORKS | click | DOM | tools |
| Выключить download_file | WORKS | click | DOM | tools |
| Выключить edit_file | WORKS | click | DOM | tools |
| Выключить enable_tools | WORKS | click | DOM | tools |
| Выключить file_info | WORKS | click | DOM | tools |
| Выключить git | WORKS | click | DOM | tools |
| Выключить glob | WORKS | click | DOM | tools |
| Выключить grep | WORKS | click | DOM | tools |
| Выключить list_dir | WORKS | click | DOM | tools |
| Выключить load_skill | WORKS | click | DOM | tools |
| Выключить lsp_check | WORKS | click | DOM | tools |
| Выключить mcp_call | WORKS | click | DOM | tools |
| Выключить meet_done | WORKS | click | DOM | tools |
| Выключить move_file | WORKS | click | DOM | tools |
| Выключить pipeline_run | WORKS | click | DOM | tools |
| Выключить plan | WORKS | click | DOM | tools |
| Выключить plan_step | WORKS | click | DOM | tools |
| Выключить plugin__weather__weather | WORKS | click | DOM | tools |
| Выключить process_kill | WORKS | click | DOM | tools |
| Выключить process_list | WORKS | click | DOM | tools |
| Выключить process_log | WORKS | click | DOM | tools |
| Выключить process_wait | WORKS | click | DOM | tools |
| Выключить project_map | WORKS | click | DOM | tools |
| Выключить question | WORKS | click | DOM | tools |
| Выключить read_file | WORKS | click | DOM | tools |
| Выключить recall | WORKS | click | DOM | tools |
| Выключить remember | WORKS | click | DOM | tools |
| Выключить scan_corpus | WORKS | click | DOM | tools |
| Выключить search_history | WORKS | click | DOM | tools |
| Выключить session_info | WORKS | click | DOM | tools |
| Выключить set_thinking | WORKS | click | DOM | tools |
| Выключить subagent | WORKS | click | DOM | tools |
| Выключить subagent_list | WORKS | click | DOM | tools |
| Выключить subagent_stop | WORKS | click | DOM | tools |
| Выключить todo | WORKS | click | DOM | tools |
| Выключить verify | WORKS | click | DOM | tools |
| Выключить web_browse | WORKS | click | DOM | tools |
| Выключить web_fetch | WORKS | click | DOM | tools |
| Выключить web_search | WORKS | click | DOM | tools |
| Выключить write_file | WORKS | click | DOM | tools |
| высота вьюпорта | WORKS | fill:7 | field values | set-browser |
| громкость звука | WORKS | fill:probe-text | field values | set-ui |
| грувбокс | WORKS | click | DOM, config | set-ui |
| дайджест вывода тулов | WORKS | select:failures | config, field values | set-context |
| движок grep | WORKS | select:rg | config, field values | set-agent::Инструменты |
| движок TypeScript | WORKS | select:tsgo | config, field values | set-plugins::LSP |
| добавить | WORKS | click | DOM, focus BODY->memory category, field values | set-memory |
| добавить провайдера | INERT | click | element not visible after prepare | set-model |
| добавить MCP-сервер | WORKS | click | DOM, focus BODY->name, field values | set-plugins::MCP |
| доверенные хосты | WORKS | fill:probe-text | field values | set-security::DLP |
| доверенные хосты: add | WORKS | click | DOM, config, field values | set-security::DLP |
| доверенные хосты: remove host.docker.internal | WORKS | click | DOM, config, field values | set-security::DLP |
| доля бюджета скиллов | WORKS | fill:probe-text | field values | set-agent::Инструменты |
| доля системного промпта | WORKS | fill:probe-text | field values | set-context |
| Доступ | WORKS | click | DOM, field values | set-security::Обзор, set-security::Доступ, set-security::Shell и пути |
| другое… | WORKS | click | DOM, focus BODY->контекстное окно (токены), field values | menu-context |
| ёмкость леджера | WORKS | fill:7 | field values | set-context |
| забыть | WORKS | click | DOM | set-memory |
| закрепить сессию | WORKS | click | pin ☆ -> ★, повторный клик снимает | manual |
| запрещенные домены | WORKS | fill:probe-text | field values | set-security::Сеть |
| запрещенные домены: add | WORKS | click | DOM, config, field values | set-security::Сеть |
| запрещенные домены: remove ::1 | INERT | click | element not visible after prepare | set-security::Сеть |
| запрещенные домены: remove 127.0.0.1 | WORKS | click | DOM, config | set-security::Сеть |
| запрещенные домены: remove localhost | WORKS | click | DOM, config | set-security::Сеть |
| запрещенные пути | WORKS | fill:probe-text | field values | set-security::Shell и пути |
| запрещенные пути: add | WORKS | click | DOM, focus BODY->запрещенные пути, field values | set-security::Shell и пути |
| запрещенные пути: remove .env | WORKS | click | DOM | set-security::Shell и пути |
| запрещенные пути: remove .git/ | WORKS | click | DOM | set-security::Shell и пути |
| запрещенные пути: remove *.crt | WORKS | click | DOM | set-security::Shell и пути |
| запрещенные пути: remove *.key | WORKS | click | DOM | set-security::Shell и пути |
| запрещенные пути: remove *.p12 | WORKS | click | DOM | set-security::Shell и пути |
| запрещенные пути: remove *.pem | WORKS | click | DOM | set-security::Shell и пути |
| запрещенные пути: remove *.pfx | WORKS | click | DOM | set-security::Shell и пути |
| запрещенные пути: remove *.secret | WORKS | click | DOM | set-security::Shell и пути |
| запрещенные пути: remove *.token | WORKS | click | DOM | set-security::Shell и пути |
| запрещенные пути: remove bun.lock | WORKS | click | DOM | set-security::Shell и пути |
| запрещенные пути: remove node_modules/ | WORKS | click | DOM | set-security::Shell и пути |
| запрещенные пути: remove package-lock.json | WORKS | click | DOM | set-security::Shell и пути |
| запрещенные пути: remove pnpm-lock.yaml | WORKS | click | DOM | set-security::Shell и пути |
| запрещенные пути: remove probe-text-80355 | WORKS | click | DOM, config | set-security::Shell и пути |
| запрещенные пути: remove yarn.lock | WORKS | click | DOM | set-security::Shell и пути |
| зима | WORKS | click | DOM, config | set-ui |
| Изменения | WORKS | click | DOM, field values | main, menu-provider, menu-model |
| изменить | INERT | click | element not visible after prepare | set-model |
| изменить провайдера | WORKS | click | DOM, focus BODY->шаблон, field values | set-model |
| имя | WORKS | fill:probe-text | DOM, field values | set-agent::Эксперты |
| имя сервиса | WORKS | fill:probe-text | config, field values | set-advanced |
| инструменты | WORKS | click | DOM | main, menu-provider, menu-model |
| Инструменты | WORKS | click | DOM, field values | set-agent, set-agent::Инструменты, set-agent::Критик |
| интервал проверки (мс) | WORKS | fill:7 | config, field values | set-general |
| кап синхронного ожидания (мс) | WORKS | fill:7 | config, field values | set-service |
| Карта | WORKS | click | DOM | menu-provider, menu-model, menu-context |
| картинки | WORKS | click | DOM | main, menu-provider, menu-model |
| картинок на запрос | WORKS | fill:7 | field values | set-network |
| консоль | INERT | click | no observable change | set-ui |
| контраст | WORKS | click | DOM, config | set-ui |
| копировать | WORKS | click | DOM, clipboard | main, menu-provider, menu-model |
| копировать как markdown | WORKS | click | DOM, clipboard | main, menu-provider, menu-model |
| Критик | WORKS | click | DOM, field values | set-agent, set-agent::Эксперты, set-agent::Критик |
| кулдаун переопределения | WORKS | fill:7 | config, field values | set-reasoning |
| лето | WORKS | click | DOM, config | set-ui |
| лимит запроса ошибки | WORKS | fill:7 | field values | set-network |
| лимит размера изображений | WORKS | fill:7 | field values | set-ui |
| лимит сводки субагента | WORKS | fill:7 | field values | set-agent::Субагенты |
| лимит файлов индекса | WORKS | fill:7 | field values | set-context |
| лимит черновиков capabilities | WORKS | fill:7 | field values | set-plugins::Плагины |
| макс. вызовов критика | WORKS | fill:7 | config, field values | set-agent, set-agent::Критик |
| макс. глубина рекурсии | WORKS | click | input 3 -> 17; config.security.maxRecursionDepth=17 | set-security::Обзор, manual |
| макс. длительность субагента (мс) | WORKS | fill:7 | field values | set-agent::Субагенты |
| макс. задач в очереди сессии | WORKS | fill:7 | config, field values | set-service |
| макс. задержка повтора | WORKS | fill:7 | config, field values | set-advanced |
| макс. записей консоли | WORKS | fill:7 | config, field values | set-browser |
| макс. запросов в минуту | WORKS | click | input 60 -> 17; config.security.rateLimits.maxRequestsPerMinute=17 | set-security::Обзор, manual |
| макс. итераций тулов | WORKS | fill:7 | config, field values | set-general |
| макс. параллельных задач | INERT | click | element not visible after prepare | set-security::Обзор |
| макс. повторов | WORKS | fill:7 | config, field values | set-advanced |
| макс. повторов аудита | WORKS | fill:7 | config, field values | set-security::Аудит |
| макс. повторов стрима | WORKS | fill:7 | config, field values | set-advanced |
| макс. размер ответа | INERT | click | element not visible after prepare | set-security::Обзор |
| макс. рассуждения | WORKS | select:minimal | config, field values | set-reasoning |
| макс. сессий | WORKS | fill:7 | config, field values | set-sessions |
| макс. содержимого страницы | WORKS | fill:7 | field values | set-browser |
| макс. строки консоли | WORKS | fill:7 | field values | set-browser |
| макс. файловых операций | INERT | click | element not visible after prepare | set-security::Обзор |
| макс. элементов страницы | WORKS | fill:7 | config, field values | set-browser |
| мин. загрузка компакции | WORKS | fill:probe-text | field values | set-context |
| мин. рассуждения | WORKS | select:minimal | config, field values | set-reasoning |
| мин. серьезность аудита | WORKS | select:low | config, field values | set-security::Аудит |
| мин. уверенность | WORKS | fill:probe-text | field values | set-security::DLP |
| Модели | WORKS | click | DOM, field values | set-model |
| модель критика | WORKS | select:deepseek-v4-pro-9b | config, field values | set-agent, set-agent::Критик |
| настройки плагина: angular11 | WORKS | click | DOM | set-plugins::Плагины |
| настройки плагина: lint-on-write | WORKS | click | DOM | set-plugins::Плагины |
| настройки плагина: notify | WORKS | click | DOM | set-plugins::Плагины |
| настройки плагина: telegram-notify | WORKS | click | DOM, focus tab-plugins->Bot token, field values | set-plugins::Плагины |
| неон | WORKS | click | DOM, config | set-ui |
| нижний порог калибровки | WORKS | fill:probe-text | field values | set-context |
| Обзор | WORKS | click | DOM, field values | set-security::Обзор, set-security::Shell и пути |
| обновить список | WORKS | click | DOM, focus selModelSearch->BODY, field values | menu-model |
| образ песочницы | WORKS | fill:probe-text | config, field values | set-general |
| окно контекста | WORKS | fill:7 | DOM, field values | set-context |
| окно отвязки хода (мс) | WORKS | fill:7 | config, field values | set-service |
| опасные операторы | WORKS | fill:probe-text | field values | set-security::Shell и пути |
| опасные операторы: add | WORKS | click | DOM, focus BODY->опасные операторы, field values | set-security::Shell и пути |
| опасные операторы: remove ; | WORKS | click | DOM | set-security::Shell и пути |
| опасные операторы: remove && | WORKS | click | DOM | set-security::Shell и пути |
| опасные операторы: remove ' | WORKS | click | DOM | set-security::Shell и пути |
| опасные операторы: remove > | WORKS | click | DOM | set-security::Shell и пути |
| опасные операторы: remove >> | WORKS | click | DOM | set-security::Shell и пути |
| опасные операторы: remove \| | WORKS | click | DOM | set-security::Shell и пути |
| опасные операторы: remove \|\| | WORKS | click | DOM | set-security::Shell и пути |
| опасные операторы: remove $( | WORKS | click | DOM | set-security::Shell и пути |
| опасные операторы: remove 2> | WORKS | click | DOM | set-security::Shell и пути |
| опасные операторы: remove 2>> | WORKS | click | DOM | set-security::Shell и пути |
| опасные операторы: remove probe-text-65100 | WORKS | click | DOM, config | set-security::Shell и пути |
| опасные флаги | WORKS | fill:probe-text | field values | set-security::Shell и пути |
| опасные флаги: add | WORKS | click | DOM, focus BODY->опасные флаги, field values | set-security::Shell и пути |
| опасные флаги: remove --all | WORKS | click | DOM | set-security::Shell и пути |
| опасные флаги: remove --dangerous | WORKS | click | DOM | set-security::Shell и пути |
| опасные флаги: remove --delete | WORKS | click | DOM | set-security::Shell и пути |
| опасные флаги: remove --force | WORKS | click | DOM | set-security::Shell и пути |
| опасные флаги: remove --no-confirm | WORKS | click | DOM | set-security::Shell и пути |
| опасные флаги: remove --no-preserve-root | WORKS | click | DOM | set-security::Shell и пути |
| опасные флаги: remove --recursive | WORKS | click | DOM | set-security::Shell и пути |
| опасные флаги: remove --remove | WORKS | click | DOM | set-security::Shell и пути |
| опасные флаги: remove -e | WORKS | click | DOM | set-security::Shell и пути |
| опасные флаги: remove -rf | WORKS | click | DOM | set-security::Shell и пути |
| опасные флаги: remove -x | WORKS | click | DOM | set-security::Shell и пути |
| опасные флаги: remove probe-text-53727 | WORKS | click | DOM, config | set-security::Shell и пути |
| осень | WORKS | click | DOM, config | set-ui |
| оставлять свежие tool-результаты | WORKS | fill:7 | config, field values | set-context |
| память: мин. символов | WORKS | fill:7 | config, field values | set-memory |
| память: мин. слов | WORKS | fill:7 | config, field values | set-memory |
| память: порог дубликата | WORKS | fill:probe-text | field values | set-memory |
| память: хранение (дней) | WORKS | fill:7 | config, field values | set-memory |
| параллельные чанки субагента | WORKS | fill:7 | config, field values | set-agent::Субагенты |
| перезагрузить плагины | WORKS | click | DOM | set-plugins::Плагины |
| Переиндексировать | WORKS | click | DOM | sidebar-more, set-agent::Эксперты, set-model |
| переопределения цен: add | WORKS | click | DOM, focus BODY->probe-text-33077: input $/1M, field values | set-advanced |
| переопределения цен: new имя | WORKS | fill:probe-text | field values | set-advanced |
| Плагины | WORKS | click | DOM | menu-provider, menu-model, menu-context |
| плоская | WORKS | click | DOM, config | set-ui |
| подробность | WORKS | select:normal | config, field values | set-general |
| поиск инструментов | WORKS | fill:probe | DOM, field values | tools |
| поиск навыков… | WORKS | fill:probe-text | field values | set-skills |
| поиск по памяти… | WORKS | fill:probe-text | DOM, field values | set-memory |
| поисков ошибок за сессию | WORKS | fill:7 | config, field values | set-network |
| показ черновика | WORKS | select:live | config, field values | set-ui |
| показать остальные вкладки | WORKS | click | DOM | main, menu-provider, menu-model |
| политика компакции | WORKS | select:legacy | config, field values | set-context |
| порог застревания | WORKS | fill:7 | config, field values | set-general |
| порог компакции | WORKS | fill:probe-text | field values | set-context |
| порог поиска ошибок | WORKS | fill:7 | config, field values | set-network |
| порог admission | WORKS | fill:7 | field values | set-context |
| порт сервиса | WORKS | fill:7 | config, field values | set-service |
| Прикрепить путь .tmp-server.js | INERT | click | element not visible after prepare | sidebar-Файлы |
| Прикрепить путь AGENTS.md | INERT | click | element not visible after prepare | sidebar-Файлы |
| Прикрепить путь meme.svg | INERT | click | element not visible after prepare | sidebar-Файлы |
| провайдер критика | WORKS | select:llama.cpp | config, field values | set-agent, set-agent::Критик |
| провайдер поиска | WORKS | select:tavily | config, field values | set-network |
| Провайдеры | WORKS | click | DOM, field values | set-model |
| прогрев калибровки | WORKS | fill:7 | config, field values | set-context |
| Производительность | WORKS | click | DOM, field values | set-model |
| профиль исполнения | WORKS | select:sandbox | config, field values | set-general |
| профиль промпта | WORKS | select:full | config, field values | set-general |
| путь аудит-лога | WORKS | fill:probe-text | config, field values | set-security::Аудит |
| путь к леджеру адресов | WORKS | fill:probe-text | config, field values | set-context |
| путь ключа шифрования | WORKS | fill:probe-text | config, field values | set-security::Аудит |
| размер шрифта | WORKS | select:compact | config, field values | set-ui |
| разрешенные домены | WORKS | fill:probe-text | field values | set-security::Сеть |
| разрешенные домены: add | WORKS | click | DOM, config, field values | set-security::Сеть |
| разрешенные пути | WORKS | fill:probe-text | field values | set-security::Shell и пути |
| разрешенные пути: add | WORKS | click | DOM, focus BODY->разрешенные пути, field values | set-security::Shell и пути |
| разрешенные пути: remove probe-text-82543 | WORKS | click | DOM, config | set-security::Shell и пути |
| Рассуждения | WORKS | click | DOM, focus BODY->tab-context, field values | menu-reasoning |
| рассуждения: prompt-tag | WORKS | click | DOM | main, menu-provider, menu-model |
| рассуждения: template-kwarg | WORKS | click | DOM | set-security::Shell и пути, set-agent::Критик, set-agent::Эксперты |
| режим путей | WORKS | select:full | config | set-security::DLP |
| режим рассуждений | WORKS | select:default | DOM, config, field values | set-reasoning |
| режим результата субагентов | WORKS | select:file | config, field values | set-agent::Субагенты |
| резерв ответа | WORKS | fill:probe-text | field values | set-context |
| результатов поиска ошибок | WORKS | fill:7 | config, field values | set-network |
| рейка активности | WORKS | select:off | config, field values | set-ui |
| сводка компакции | WORKS | select:off | config, field values | set-context |
| секрет HMAC webhook | WORKS | fill:probe-text | config, field values | set-service |
| Сессия | WORKS | click | DOM | main, menu-provider, menu-model |
| сетевой таймаут (мс) | WORKS | click | input 15000 -> 17000; config.security.network.requestTimeout=17000 | set-security::Обзор, manual |
| Сеть | WORKS | click | DOM, field values | set-security::Обзор, set-security::Сеть, set-security::Shell и пути |
| Скопировать путь в рабочей папке | WORKS | click | clipboard | set-agent::Критик, set-agent::Эксперты, set-plugins::Плагины |
| скрыто от API | WORKS | fill:probe-text | field values | set-security::DLP |
| скрыто от API: add | WORKS | click | DOM, config, field values | set-security::DLP |
| сменить модель | WORKS | click | DOM, field values | set-model |
| Субагенты | WORKS | click | DOM | main, menu-provider, menu-model |
| таймаут аудит-вебхука (мс) | WORKS | fill:7 | field values | set-security::Аудит |
| таймаут застоя стрима (мс) | WORKS | fill:7 | field values | set-advanced |
| таймаут критика (мс) | WORKS | fill:7 | field values | set-agent, set-agent::Критик |
| таймаут навигации (мс) | WORKS | fill:7 | field values | set-browser |
| таймаут поиска ошибок (мс) | WORKS | fill:7 | field values | set-network |
| таймаут webhook (мс) | WORKS | fill:7 | field values | set-service |
| теги тулов по умолчанию | WORKS | fill:probe-text | field values | set-agent::Инструменты |
| теги тулов по умолчанию: add | WORKS | click | DOM, config, field values | set-agent::Инструменты |
| теги тулов по умолчанию: remove code | WORKS | click | defaultTags ["file","code"] -> ["file"] | set-agent::Инструменты, manual |
| теги тулов по умолчанию: remove file | WORKS | click | DOM, config | set-agent::Инструменты |
| тенант сервиса | WORKS | fill:probe-text | config, field values | set-service |
| Трассировка | WORKS | click | DOM | menu-provider, menu-model, menu-context |
| удалить сессию | WORKS | click | alertdialog «Удалить сессию?» с кнопками отмена/удалить; отменено | manual |
| уровень логов | WORKS | select:silent | config, field values | set-advanced |
| Файлы | WORKS | click | DOM, field values | main, menu-provider, menu-model |
| хранение результатов (дни) | INERT | fill:7 | no observable change | set-service |
| хранимых изображений | WORKS | fill:7 | config, field values | set-ui |
| циклы исправления критика | WORKS | fill:7 | field values | set-agent, set-agent::Критик |
| черный список bash | WORKS | fill:probe-text | field values | set-security::Shell и пути |
| черный список bash: add | WORKS | click | DOM, focus BODY->черный список bash, field values | set-security::Shell и пути |
| черный список bash: remove attrib | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove bash | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove bitsadmin | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove busybox | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove certutil | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove chgrp | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove chmod | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove chown | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove cmd | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove cscript | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove curl | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove dash | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove dd | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove del | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove diskpart | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove erase | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove eval | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove exec | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove fdisk | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove format | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove halt | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove icacls | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove kill | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove killall | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove ln | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove mkfifo | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove mkfs | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove mknod | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove mount | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove mshta | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove nc | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove netcat | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove node | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove parted | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove passwd | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove perl | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove pkill | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove poweroff | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove powershell | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove probe-text-38982 | WORKS | click | DOM, config | set-security::Shell и пути |
| черный список bash: remove pwsh | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove python | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove python3 | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove rd | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove reboot | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove reg | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove rm | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove rmdir | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove ruby | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove scp | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove sh | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove shred | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove shutdown | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove source | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove ssh | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove su | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove sudo | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove takeown | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove taskkill | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove truncate | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove umount | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove unlink | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove useradd | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove usermod | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove wget | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove wscript | WORKS | click | DOM | set-security::Shell и пути |
| черный список bash: remove zsh | WORKS | click | DOM | set-security::Shell и пути |
| ширина вьюпорта | WORKS | fill:7 | field values | set-browser |
| Эксперты | WORKS | click | DOM | set-agent, set-agent::Эксперты, set-agent::Критик |
| язык | WORKS | select:en | DOM, config, field values | set-general |
| Access | WORKS | click | DOM, field values | set-security::Обзор, set-security::Shell и пути, set-security::Аудит |
| activity rail | WORKS | select:off | config, field values | set-ui |
| API-ключ провайдера поиска | WORKS | fill:probe-text | config, field values | set-network |
| attachBtn | WORKS | click | скрытый input[type=file] найден; системный диалог выбора файла не эмулируется | main, menu-provider, menu-model |
| Audit | WORKS | click | DOM, field values | set-security::Обзор, set-security::Shell и пути, set-security::Аудит |
| auto | WORKS | click | DOM, config | set-ui |
| auto128K | WORKS | click | DOM | menu-context |
| autoтекущее | WORKS | click | DOM | menu-reasoning |
| autumn | WORKS | click | DOM, config | set-ui |
| bearer-токен сервиса | WORKS | fill:probe-text | config, field values | set-service |
| browser 1 | WORKS | click | DOM | tools |
| browser: модель | WORKS | select:deepseek-v4-pro-9b | DOM, field values | set-agent::Эксперты |
| browser: описание | WORKS | fill:probe-text | DOM, field values | set-agent::Эксперты |
| browser: попытки | WORKS | fill:7 | DOM, field values | set-agent::Эксперты |
| browser: провайдер | WORKS | select:llama.cpp | DOM, field values | set-agent::Эксперты |
| browser: теги инструментов | WORKS | fill:probe-text | DOM, field values | set-agent::Эксперты |
| BUTTON | WORKS | click | config | set-general, set-agent, set-agent::Эксперты |
| Capabilities | WORKS | click | DOM, field values | set-model |
| change model | WORKS | click | DOM | set-model |
| Changes | WORKS | click | DOM, field values | set-general, set-model, set-agent |
| check 1 | WORKS | click | DOM | tools |
| closeSettings | WORKS | click | DOM, field values | set-general, set-model, set-agent |
| closeSub | WORKS | click | DOM, focus поиск инструментов->BODY, field values | tools |
| code 12 | WORKS | click | DOM | tools |
| code: модель | WORKS | select:deepseek-v4-pro-9b | field values | set-agent::Эксперты |
| code: описание | WORKS | fill:probe-text | DOM, field values | set-agent::Эксперты |
| code: попытки | WORKS | fill:7 | DOM, field values | set-agent::Эксперты |
| code: провайдер | WORKS | select:llama.cpp | DOM, field values | set-agent::Эксперты |
| code: теги инструментов | WORKS | fill:probe-text | DOM, field values | set-agent::Эксперты |
| console | INERT | click | no observable change | set-ui |
| contrast | WORKS | click | DOM, config | set-ui |
| conventions 0 | WORKS | click | DOM | set-memory |
| cooldown переполнения | WORKS | fill:7 | config, field values | set-context |
| copy | WORKS | click | DOM, clipboard | set-general, set-model, set-agent |
| copy as markdown | WORKS | click | DOM, clipboard | set-general, set-model, set-agent |
| core 3 | WORKS | click | DOM | tools |
| Critic | WORKS | click | DOM, field values | set-agent, set-agent::Эксперты, set-agent::Инструменты |
| dark | INERT | click | no observable change | set-ui |
| decisions 0 | WORKS | click | DOM | set-memory |
| deepseek-v4-pro-9b | WORKS | click | DOM, focus selModelSearch->BODY, field values | menu-model |
| default | WORKS | click | DOM | menu-reasoning |
| default tool tags | WORKS | fill:probe-text | DOM, field values | set-agent, set-agent::Эксперты, set-agent::Инструменты |
| default tool tags: add | WORKS | click | DOM, focus BODY->default tool tags, field values | set-agent, set-agent::Эксперты, set-agent::Инструменты |
| default tool tags: remove code | WORKS | click | DOM | set-agent |
| default tool tags: remove probe-text-40864 | WORKS | click | DOM | set-agent::Эксперты |
| default tool tags: remove probe-text-44702 | WORKS | click | DOM, config | set-agent, set-agent::Инструменты |
| default tool tags: remove probe-text-56619 | WORKS | click | DOM | set-agent::Критик, set-agent::Эксперты |
| default tool tags: remove probe-text-70525 | WORKS | click | DOM, config | set-agent::Инструменты |
| default tool tags: remove probe-text-85240 | WORKS | click | DOM, config | set-agent::Эксперты |
| disabled plugins | WORKS | fill:probe-text | field values | set-advanced |
| disabled plugins: add | WORKS | click | config, focus tab-advanced->BODY, field values | set-advanced |
| disabled plugins: remove probe-text-38211 | WORKS | click | config | set-advanced |
| disabled plugins: remove telegram-notify | WORKS | click | config | set-advanced |
| DLP | WORKS | click | DOM, field values | set-security::Обзор, set-security::DLP, set-security::Shell и пути |
| DLP: отредактировано значений — 0 | WORKS | click | DOM | main, menu-provider, menu-model |
| DLP: отредактировано значений — 42 | WORKS | click | DOM | set-security::Shell и пути, set-agent::Критик, set-agent::Эксперты |
| DLP: redacted values — 42 | WORKS | click | DOM | set-model, set-agent, set-agent::Эксперты |
| document 4 | WORKS | click | DOM | tools |
| draft display | WORKS | select:live | config, field values | set-ui |
| edit | WORKS | click | DOM, focus tab-plugins->command, field values | set-plugins::Плагины |
| edit provider | WORKS | click | DOM, focus BODY->preset, field values | set-model |
| endpoint OTLP | WORKS | fill:probe-text | DOM, config, field values | set-advanced |
| errors 21 | WORKS | click | DOM | set-memory |
| execution profile | WORKS | select:sandbox | config, field values | set-general |
| Experts | WORKS | click | DOM, field values | set-agent, set-agent::Эксперты, set-agent::Инструменты |
| Experts: add | WORKS | click | DOM, focus BODY->probe-text-96772: провайдер, field values | set-agent::Эксперты |
| Experts: new имя | WORKS | fill:probe-text | DOM, field values | set-agent::Эксперты |
| Experts: remove browser | WORKS | click | DOM, field values | set-agent::Эксперты |
| Experts: remove code | WORKS | click | DOM, field values | set-agent::Эксперты |
| Experts: remove research | WORKS | click | DOM, field values | set-agent::Эксперты |
| Experts: remove vision | WORKS | click | DOM, field values | set-agent::Эксперты |
| facts 2 | WORKS | click | DOM | set-memory |
| file 15 | WORKS | click | DOM | tools |
| Files | WORKS | click | DOM, field values | set-general, set-model, set-agent |
| filesCollapseAll | WORKS | click | DOM | sidebar-Файлы, set-service |
| filesExpandAll | WORKS | click | DOM | sidebar-Файлы, set-service |
| filesRefresh | WORKS | click | DOM | sidebar-Файлы, set-service |
| filesSearch | WORKS | fill:probe | DOM, field values | sidebar-Файлы, set-service |
| filesSearchClear | INERT | click | element not visible after prepare | set-service |
| flat | WORKS | click | DOM, config | set-ui |
| font size | WORKS | select:compact | config, field values | set-ui |
| grep engine | WORKS | select:auto | DOM, field values | set-agent, set-agent::Эксперты, set-agent::Инструменты |
| groovebox | WORKS | click | DOM, config | set-ui |
| idle-таймаут субагента (мс) | WORKS | fill:7 | field values | set-agent::Субагенты |
| image 1 | WORKS | click | DOM | tools |
| inp | WORKS | fill:probe-text | field values | main, menu-provider, menu-model |
| INPUT | INERT | fill:probe-text | no observable change | set-security::Аудит |
| language | WORKS | select:en | DOM, config, field values | set-general |
| light | WORKS | click | DOM, config | set-ui |
| llama.cppopenai-compat | WORKS | click | DOM, config | menu-provider |
| log level | WORKS | select:silent | config, field values | set-advanced |
| LSP | WORKS | click | DOM | menu-provider, menu-model, menu-context |
| Map | WORKS | click | DOM | set-general, set-model, set-agent::Эксперты |
| max retries | WORKS | fill:7 | config, field values | set-advanced |
| max stream retries | WORKS | fill:7 | config, field values | set-advanced |
| max tool iterations | WORKS | fill:7 | config, field values | set-general |
| MCP | WORKS | click | DOM | menu-provider, menu-model, menu-context |
| memory 3 | WORKS | click | DOM | tools |
| meta 1 | WORKS | click | DOM | tools |
| Metallica | WORKS | click | DOM, config | set-ui |
| model capabilities: add | WORKS | click | DOM, focus BODY->probe-text-19616: vision, field values | set-model |
| model capabilities: new name | WORKS | fill:probe-text | field values | set-model |
| Models | WORKS | click | DOM, field values | set-model |
| neon | WORKS | click | DOM, config | set-ui |
| Network | WORKS | click | DOM, field values | set-security::Обзор, set-security::Shell и пути, set-security::Аудит |
| newChat | WORKS | click | DOM, URL, tabs 40->41, focus tab-ui->inp | main, menu-provider, menu-model |
| Omarchy | WORKS | click | DOM, config | set-ui |
| openSettings | WORKS | click | DOM, field values | main, menu-provider, menu-model |
| OTLP endpoint | WORKS | fill:probe-text | DOM, config, field values | set-advanced |
| Overview | WORKS | click | DOM, field values | set-security::Обзор, set-security::Shell и пути, set-security::Аудит |
| paper | WORKS | click | DOM, config | set-ui |
| per-run budget USD | WORKS | fill:7 | config, field values | set-general |
| Performance | WORKS | click | DOM, field values | set-model |
| plugin:weather 1 | WORKS | click | DOM | tools |
| Plugins | WORKS | click | DOM, field values | set-general, set-model, set-agent::Эксперты |
| pricing overrides: add | WORKS | click | DOM, focus tab-advanced->probe-text-94626: input $/1M, field values | set-advanced |
| pricing overrides: new name | WORKS | fill:probe-text | field values | set-advanced |
| prompt profile | WORKS | select:full | config, field values | set-general |
| Providers | WORKS | click | DOM, field values | set-model |
| qwen3.8-27b-uncensored | WORKS | click | меню модели: deepseek-v4-pro-9b -> qwen3.8-27b-uncensored | menu-model, manual |
| Re-index | INERT | click | no observable change | set-model, set-agent, set-agent::Инструменты |
| reasoning: prompt-tag | WORKS | click | DOM | set-general, set-model, set-agent |
| reload plugins | WORKS | click | DOM | set-plugins::Плагины |
| research 10 | WORKS | click | DOM | tools |
| research: модель | WORKS | select:deepseek-v4-pro-9b | DOM, field values | set-agent::Эксперты |
| research: описание | WORKS | fill:probe-text | DOM, field values | set-agent::Эксперты |
| research: попытки | WORKS | fill:7 | DOM, field values | set-agent::Эксперты |
| research: провайдер | WORKS | select:llama.cpp | DOM, field values | set-agent::Эксперты |
| research: теги инструментов | WORKS | fill:probe-text | DOM, field values | set-agent::Эксперты |
| retry base delay | WORKS | fill:7 | config, field values | set-advanced |
| retry max delay | WORKS | fill:7 | config, field values | set-advanced |
| sandbox image | WORKS | fill:probe-text | config, field values | set-general |
| sbSettings | WORKS | click | DOM, field values | main, menu-provider, menu-model |
| Security | WORKS | click | DOM | set-general, set-model, set-agent::Эксперты |
| selContextBtn | WORKS | click | DOM | main, menu-provider, menu-model |
| selModelBtn | WORKS | click | DOM, focus tab-ui->selModelSearch, field values | main, menu-provider, menu-model |
| selModelSearch | WORKS | fill:probe | DOM, field values | menu-model |
| selProviderBtn | WORKS | click | DOM | main, menu-provider, menu-model |
| selReasoningBtn | WORKS | click | DOM | main, menu-provider, menu-model |
| sendBtn | WORKS | click | DOM, field values | main, menu-provider, menu-model |
| service name | WORKS | fill:probe-text | config, field values | set-advanced |
| sessBtn | WORKS | click | DOM, focus tab-ui->sessSearch, field values | main, menu-provider, menu-model |
| Session | WORKS | click | DOM | set-general, set-model, set-agent |
| sessNew | WORKS | click | DOM, URL, tabs 9->10, focus sessSearch->inp, field values | sessions |
| sessRefresh | WORKS | click | DOM, focus sessSearch->BODY, field values | sessions |
| sessSearch | WORKS | fill:probe | DOM, field values | sessions |
| setSearch | WORKS | fill:probe | DOM, field values | set-general, set-model, set-agent |
| setSearchClear | WORKS | click | DOM, field values | set-general, set-agent, set-agent::Инструменты |
| Shell & paths | WORKS | click | DOM, field values | set-security::Обзор, set-security::Shell и пути, set-security::Аудит |
| shell 7 | WORKS | click | DOM | tools |
| Shell и пути | WORKS | click | DOM | set-security::Обзор, set-security::Shell и пути |
| skills budget share | WORKS | fill:probe-text | DOM, field values | set-agent, set-agent::Эксперты, set-agent::Инструменты |
| skip to messages | WORKS | link:#msgs | focus tab-ui->msgs | main, menu-provider, menu-model |
| sound volume | WORKS | fill:probe-text | field values | set-ui |
| spring | WORKS | click | DOM, config | set-ui |
| stored images kept | WORKS | fill:7 | config, field values | set-ui |
| stored images size cap | WORKS | fill:7 | field values | set-ui |
| stream stall timeout (ms) | WORKS | fill:7 | field values | set-advanced |
| stuck threshold | WORKS | fill:7 | config, field values | set-general |
| Sub-agents | WORKS | click | DOM, field values | set-agent, set-agent::Эксперты, set-agent::Инструменты |
| Subagents | WORKS | click | DOM | set-general, set-model, set-agent |
| summer | WORKS | click | DOM, config | set-ui |
| TLS-ключ (путь к PEM) | WORKS | fill:probe-text | config, field values | set-service |
| TLS-сертификат (путь к PEM) | WORKS | fill:probe-text | config, field values | set-service |
| tools | WORKS | click | DOM | set-general, set-model, set-agent |
| Tools & skills | WORKS | click | DOM, field values | set-agent, set-agent::Эксперты, set-agent::Инструменты |
| toolsBtn | WORKS | click | focus tab-ui->поиск инструментов, field values | main, menu-provider, menu-model |
| Trace | WORKS | click | DOM | set-general, set-model, set-agent::Эксперты |
| TTL идемпотентности (часы) | WORKS | fill:7 | config, field values | set-service |
| TypeScript engine | WORKS | select:tsgo | DOM, field values | set-plugins::Плагины |
| update check interval (ms) | WORKS | fill:7 | config, field values | set-general |
| URL аудит-вебхука | INERT | fill:probe-text | no observable change | set-security::Аудит |
| verbosity | WORKS | select:normal | config, field values | set-general |
| video | WORKS | click | DOM | set-general, set-model, set-agent |
| vision | WORKS | click | DOM | set-general, set-model, set-agent |
| vision 2 | WORKS | click | DOM | tools |
| vision: модель | WORKS | select:deepseek-v4-pro-9b | DOM, field values | set-agent::Эксперты |
| vision: описание | WORKS | fill:probe-text | DOM, field values | set-agent::Эксперты |
| vision: попытки | WORKS | fill:7 | DOM, field values | set-agent::Эксперты |
| vision: провайдер | WORKS | select:llama.cpp | DOM, field values | set-agent::Эксперты |
| vision: теги инструментов | WORKS | fill:probe-text | DOM, field values | set-agent::Эксперты |
| winter | WORKS | click | DOM, config | set-ui |

## Не подтверждённые контролы

Список ниже — элементы, для которых в момент замера не удалось получить наблюдаемый эффект. Большинство — артефакты состояния (скрытая вкладка, элемент за группой вкладок), а не доказанные неисправности.

- 2. Запустить и протестировать игру — element not visible after prepare (состояния: set-agent::Критик)
- 3. Продолжить разработку (фаза 2+) — element not visible after prepare (состояния: set-agent::Критик)
- 4. Другая задача — element not visible after prepare (состояния: set-agent::Критик)
- 5. свой ответ… — element not visible after prepare (состояния: set-agent::Критик)
- все 23 — no observable change (состояния: set-memory)
- все 4 — no observable change (состояния: set-skills)
- выключенные плагины: remove telegram-notify — element not visible after prepare (состояния: set-advanced)
- добавить провайдера — element not visible after prepare (состояния: set-model)
- запрещенные домены: remove ::1 — element not visible after prepare (состояния: set-security::Сеть)
- изменить — element not visible after prepare (состояния: set-model)
- консоль — no observable change (состояния: set-ui)
- макс. параллельных задач — element not visible after prepare (состояния: set-security::Обзор)
- макс. размер ответа — element not visible after prepare (состояния: set-security::Обзор)
- макс. файловых операций — element not visible after prepare (состояния: set-security::Обзор)
- Прикрепить путь .tmp-server.js — element not visible after prepare (состояния: sidebar-Файлы)
- Прикрепить путь AGENTS.md — element not visible after prepare (состояния: sidebar-Файлы)
- Прикрепить путь meme.svg — element not visible after prepare (состояния: sidebar-Файлы)
- хранение результатов (дни) — no observable change (состояния: set-service)
- console — no observable change (состояния: set-ui)
- dark — no observable change (состояния: set-ui)
- filesSearchClear — element not visible after prepare (состояния: set-service)
- INPUT — no observable change (состояния: set-security::Аудит)
- Re-index — no observable change (состояния: set-model, set-agent, set-agent::Инструменты, set-security::Shell и пути, set-plugins::Плагины, set-advanced, set-agent::Критик)
- URL аудит-вебхука — no observable change (состояния: set-security::Аудит)

## Post-fix note (2026-11-19)

Отчёт описывает непатченный тег `v0_26_0`. Секция `security.scan` и четыре ключа HITL/compliance, признанные недоступными, исправлены в ветке `fix/settings-ia-gaps`: секция подключена к вкладке «Shell и пути», ключи получили дефы реестра и локализацию. Регрессионные тесты — в `tests/webui-settings-ia.test.ts`.
