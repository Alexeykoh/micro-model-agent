---
name: web-scraping
description: Web scraping and data extraction using headless browser (Playwright) and HTTP fetch. Use for parsing product catalogs, extracting structured data from websites, scraping articles, tables, and any web content. Handles dynamic SPA pages, authentication (cookies/tokens), anti-bot measures, lazy loading. Trigger on mentions of "parse", "scrape", "extract data from website", "парсинг", "спарсить", "вытасти данные с сайта".
---

# Web Scraping & Data Extraction

高效的 web-парсинг через headless browser (Playwright) и HTTP fetch. Минимум ходов — максимум данных.

## Core Rule: 3-Step Pattern

Любая задача парсинга сводится к 3 шагам:

```
Step 1: navigate → открыть страницу
Step 2: evaluate  → извлечь данные через JS
Step 3: write_file → сохранить результат
```

**Никогда не используйте** extract без предварительного evaluate. extract возвращает сырой HTML/text — вы тратите токены на обработку того, что JavaScript делает за 1 строку.

## Decision: web_fetch vs web_browse

```
web_fetch(url)          — простой GET, нет JS-рендеринга, нет кук/авторизации
web_browse(navigate)    — нужен JS, куки, авторизация, динамический контент
```

**Правило**: если сайт — SPA (React/Vue/Angular) или требует куки/авторизации → **всегда web_browse**. web_fetch вернёт пустой HTML.

## Playwright: Key Facts

1. **Stateful session**: `navigate` открывает страницу, все последующие action'ы работают с ней. Закрой `close` когда закончишь.
2. **Headless Chromium**: страница рендерится как в обычном браузере. JS выполняется.
3. **Auto-wait**: `navigate` ждёт `domcontentloaded` + 1с. Для тяжёлых страниц — добавляй `wait` после navigate.
4. **5-minute idle timeout**: если сессия неактивна > 5 минут, браузер закроется.
5. **Viewport 1280x720**:某些 элементы могут скрываться за `@media` запросами.

## Workflow: Product Catalog (товары)

```
1. web_browse navigate(url)
2. web_browse evaluate: document.querySelectorAll('.selector').length  // проверить сколько элементов
3. web_browse evaluate: извлечь данные через JSON
4. write_file результат
```

### Шаблон извлечения товаров

```javascript
// Step 2: найти селектор
document.querySelectorAll('.product-card, .item, .goods-item').length

// Step 3: извлечь данные (один вызов — все товары)
JSON.stringify(
  Array.from(document.querySelectorAll('.product-card')).slice(0, 10).map(el => ({
    name: el.querySelector('.title, .name, h2, h3')?.textContent?.trim(),
    price: el.querySelector('.price, .cost')?.textContent?.trim(),
    link: el.querySelector('a')?.href,
    image: el.querySelector('img')?.src,
  }))
)
```

**Ключевой момент**: один `evaluate` с `querySelectorAll` + `map` + `JSON.stringify` экономит 5-10 ходов по сравнению с `extract`.

## Workflow: Article / Blog Post

```
1. web_browse navigate(url)
2. web_browse evaluate: document.querySelector('article, .post-content, .entry-content')?.innerText
3. write_file результат
```

## Workflow: Table Data

```
1. web_browse navigate(url)
2. web_browse evaluate:
JSON.stringify(
  Array.from(document.querySelectorAll('table tr')).map(row =>
    Array.from(row.querySelectorAll('td, th')).map(cell => cell.textContent.trim())
  )
)
3. write_file результат
```

## Authentication & Cookies

### Set cookies before navigate

```javascript
// Step 1: Set cookies via evaluate (before navigate to target page)
web_browse evaluate: document.cookie = "session=abc123; path=/"

// Or set multiple cookies
web_browse evaluate: `
  document.cookie = "token=xyz; path=/; max-age=3600";
  document.cookie = "user_id=42; path=/";
`

// Step 2: Navigate (cookies are now set)
web_browse navigate: https://example.com/dashboard
```

### Login flow

```
1. web_browse navigate(url_of_login_page)
2. web_browse type(selector: 'input[name="email"]', value: 'user@example.com')
3. web_browse type(selector: 'input[name="password"]', value: 'pass')
4. web_browse click(selector: 'button[type="submit"]')
5. web_browse wait(condition: "window.location.href.includes('dashboard')")
6. web_browse navigate(target_url_to_scrape)
7. web_browse evaluate: извлечь данные
```

### Token-based auth (Authorization header)

```javascript
// Set token via evaluate before navigation
web_browse evaluate: `
  fetch('/api/data', {
    headers: { 'Authorization': 'Bearer YOUR_TOKEN' }
  }).then(r => r.json()).then(d => JSON.stringify(d))
`
```

## Anti-Bot Handling

### User-Agent (already set by default)

Playwright session uses Chrome user-agent by default. If site blocks headless:

```javascript
// Check if page loaded correctly
web_browse evaluate: document.title + ' | ' + document.querySelectorAll('body > *').length

// If blocked (captcha, empty page), try:
web_browse evaluate: document.querySelector('.captcha, #challenge, [data-testid="challenge"]') ? 'BLOCKED' : 'OK'
```

### Rate limiting

Не делай больше 5 navigate подряд без паузы. Если получаешь 429/503:

```
web_browse wait(timeout: 5000)   // подождать 5 секунд
web_bavigate navigate(url)        // повторить
```

### Cloudflare / JS challenges

```javascript
// Wait for challenge to resolve
web_browse wait(condition: "document.querySelector('#challenge-running') === null", timeout: 15000)
```

## Dynamic Content (SPA / Lazy Loading)

### Wait for content to appear

```
1. web_browse navigate(url)
2. web_browse wait(selector: '.product-card', timeout: 10000)  // ждём пока появятся товары
3. web_browse evaluate: извлечь данные
```

### Infinite scroll

```javascript
// Scroll to bottom to trigger lazy loading
web_browse scroll(direction: 'down')
web_browse scroll(direction: 'down')
web_browse wait(condition: "document.querySelectorAll('.item').length >= 20", timeout: 10000)
web_browse evaluate: извлечь все данные
```

### AJAX/API data (получить данные из network)

```javascript
// Intercept XHR responses
web_browse evaluate: `
  new Promise((resolve) => {
    const origFetch = window.fetch;
    window.fetch = async (...args) => {
      const res = await origFetch(...args);
      if (args[0].includes('/api/products')) {
        const data = await res.clone().json();
        resolve(JSON.stringify(data));
      }
      return res;
    };
    // Trigger reload to capture API call
    location.reload();
  })
`
```

## Common Mistakes (Чего НЕ делать)

### DON'T: extract without knowing the structure

```
# ПЛОХО — тратишь токены на сырой HTML
web_browse extract(format: 'html')
web_browse extract(format: 'text')
web_browse scroll(direction: 'down')  # зачем?
web_browse scroll(direction: 'down')  # и ещё раз?
```

### DON'T: write Node.js scripts for simple tasks

```
# ПЛОХО — npm init, npm install, write_file скрипта, syntax error, ...
bash: npm init -y
bash: npm install axios
write_file: parse.js  // SyntaxError: missing /
```

### DON'T: extract with wrong selectors repeatedly

```
# ПЛОХО — пробуешь 5 разных селекторов
web_browse extract(selector: '.product-card')
web_browse extract(selector: '.item')
web_browse extract(selector: '.goods')
web_browse extract(selector: '.product')
```

### RIGHT: discover structure once, extract smart

```
# ПРАВИЛЬНО — 1 navigate + 1 evaluate для структуры + 1 evaluate для данных
web_browse navigate(url)
web_browse evaluate: document.querySelector('body').innerHTML.substring(0, 500)  // посмотреть структуру
web_browse evaluate: JSON.stringify(Array.from(document.querySelectorAll('...')).map(...))
```

## File Writing Rules

- **1 файл за ход**: если нужно создать несколько файлов — используй subagent
- **write_file блокируется** если > 3 файлов написано без subagent
- Если write_file заблокирован из-за синтаксической ошибки — **перепиши файл целиком**, не edit
- Для больших данных: сначала `evaluate` верни JSON, потом `write_file` сформатированный результат

## Debugging: Если данные не извлекаются

1. **Проверь что страница загрузилась**: `web_browse evaluate: document.title`
2. **Проверь структуру**: `web_browse evaluate: document.querySelector('body').children.length`
3. **Проверь конкретный селектор**: `web_browse evaluate: document.querySelectorAll('.your-selector').length`
4. **Посмотри raw HTML**: `web_browse extract(format: 'html', maxChars: 2000)`
5. **Проверь есть ли JS-ошибки**: `web_browse evaluate: window.onerror || 'no errors'`

## Quick Reference: Actions

| Action | Когда использовать | Параметры |
|--------|-------------------|-----------|
| `navigate` | Открыть страницу | `url` |
| `evaluate` | Выполнить JS, получить данные | `value` (JS code) |
| `extract` | Получить text/html (редко!) | `selector`, `format`, `maxChars` |
| `click` | Кликнуть по элементу | `selector` |
| `type` | Ввести текст в поле | `selector`, `value` |
| `scroll` | Прокрутить страницу | `direction` |
| `wait` | Ждать появления элемента | `selector` или `condition`, `timeout` |
| `get_links` | Получить все ссылки | — |
| `screenshot` | Скриншот страницы | `selector` |
| `close` | Закрыть браузер | — |

## Example: Real Task

**Задача**: Спарсить 10 велосипедов с каталога, записать в .md

```
1. web_browse navigate: https://shop.com/bikes
2. web_browse evaluate: document.querySelectorAll('.product-card').length
   → "27" (значит селектор правильный)
3. web_browse evaluate: JSON.stringify(Array.from(document.querySelectorAll('.product-card')).slice(0, 10).map(el => ({
     name: el.querySelector('.title')?.textContent?.trim(),
     price: el.querySelector('.price')?.textContent?.trim(),
     link: el.querySelector('a')?.href
   })))
   → JSON с 10 товарами
4. write_file: bikes.md (отформатированный результат)
5. web_browse close
```

**Итого: 5 ходов** вместо 30+ как в логе выше.
