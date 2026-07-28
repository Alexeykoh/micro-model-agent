---
name: web-scraping
description: Web scraping and data extraction using headless browser (Playwright) and HTTP fetch. Use for parsing product catalogs, extracting structured data from websites, scraping articles, tables, and any web content. Handles dynamic SPA pages, authentication (cookies/tokens), anti-bot measures, lazy loading. Trigger on mentions of "parse", "scrape", "extract data from website".
---

# Web Scraping & Data Extraction

Efficient web scraping via headless browser (Playwright) and HTTP fetch. Minimal turns — maximum data.

## Core Rule: 4-Step Pattern

Every scraping task reduces to 4 steps:

```
Step 1: navigate  → open the page
Step 2: discover  → find REAL CSS selectors on the page
Step 3: evaluate  → extract data via JS
Step 4: write_file → save the result
```

**Step 2 (discover) is MANDATORY.** Never guess selectors — look at the actual HTML.

**Never use** extract without a prior evaluate. Extract returns raw HTML/text — you spend tokens on processing what JavaScript does in 1 line.

## Decision: web_fetch vs web_browse

```
web_fetch(url)          — simple GET, no JS rendering, no cookies/auth
web_browse(navigate)    — need JS, cookies, auth, dynamic content
```

**Rule**: if the site is SPA (React/Vue/Angular) or requires cookies/auth → **always web_browse**. web_fetch will return empty HTML.

## Playwright: Key Facts

1. **Stateful session**: `navigate` opens the page, all subsequent actions work with it. Call `close` when done.
2. **Headless Chromium**: page renders like in a regular browser. JS executes.
3. **Auto-wait**: `navigate` waits for `domcontentloaded` + 1s. For heavy pages — add `wait` after navigate.
4. **5-minute idle timeout**: if session is inactive > 5 minutes, browser closes.
5. **Viewport 1280x720**: some elements may be hidden behind `@media` queries.

## Step 2: Discover — Find Real Selectors

**Mandatory step.** Don't guess classes — look at the HTML.

### Approach A: Quick discover (recommended)

```javascript
// 1. Find all product links
web_browse evaluate: JSON.stringify(
  Array.from(document.querySelectorAll('a[href]'))
    .filter(a => a.href.includes('/product') || a.href.includes('/catalog/'))
    .slice(0, 5)
    .map(a => ({href: a.href, text: a.textContent.trim().substring(0, 80), parent: a.parentElement?.className}))
)
```

The result shows: what classes the parents have, what URL pattern products use.

### Approach B: discover action (if available)

```javascript
web_browse discover
```

Returns all unique CSS classes on the page + links.

### Approach C: HTML analysis (last resort)

```javascript
// Look at structure around product links
web_browse evaluate: document.querySelector('a[href*="/product"]')?.parentElement?.parentElement?.outerHTML?.substring(0, 2000)
```

### After discover: verify the selector

```javascript
web_browse evaluate: document.querySelectorAll('your_real_selector').length
// Must be > 0, otherwise — try another selector
```

## Workflow: Product Catalog

```
1. web_browse navigate(url)
2. web_browse discover (or evaluate to find links/classes)
3. web_browse evaluate: verify selector (.length > 0)
4. web_browse evaluate: extract data via JSON
5. write_file result
```

### Product extraction template

```javascript
// Step 2: discover — find real links/classes
JSON.stringify(
  Array.from(document.querySelectorAll('a[href]'))
    .filter(a => a.href.includes('/product'))
    .slice(0, 3)
    .map(a => ({href: a.href, cls: a.closest('div[class]')?.className}))
)

// Step 3: verify selector
document.querySelectorAll('.the_class_you_found').length

// Step 4: extract data (one call — all products)
JSON.stringify(
  Array.from(document.querySelectorAll('.the_class_you_found')).slice(0, 10).map(el => ({
    name: el.querySelector('a')?.textContent?.trim() || el.querySelector('h2, h3, .title')?.textContent?.trim(),
    price: el.querySelector('.price, .cost, [class*="price"]')?.textContent?.trim(),
    link: el.querySelector('a')?.href,
    image: el.querySelector('img')?.src,
  }))
)
```

**Key point**: one `evaluate` with `querySelectorAll` + `map` + `JSON.stringify` saves 5-10 turns compared to `extract`.

## Workflow: Article / Blog Post

```
1. web_browse navigate(url)
2. web_browse evaluate: document.querySelector('article, .post-content, .entry-content')?.innerText
3. write_file result
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
3. write_file result
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
7. web_browse evaluate: extract data
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

Don't make more than 5 navigate calls in a row without a pause. If you get 429/503:

```
web_browse wait(timeout: 5000)   // wait 5 seconds
web_browse navigate(url)         // retry
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
2. web_browse wait(selector: '.product-card', timeout: 10000)  // wait for products to load
3. web_browse evaluate: extract data
```

### Infinite scroll

```javascript
// Scroll to bottom to trigger lazy loading
web_browse scroll(direction: 'down')
web_browse scroll(direction: 'down')
web_browse wait(condition: "document.querySelectorAll('.item').length >= 20", timeout: 10000)
web_browse evaluate: extract all data
```

### AJAX/API data (get data from network)

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

## Fallback Strategy (when selectors don't work)

### If evaluate with selector returned 0 elements:

```
1. web_browse get_links → find all links, check URL patterns
2. If product links found → extract data from href + text of links
3. If nothing found → web_browse extract(format: 'html', maxChars: 3000) → analyze HTML
```

### If get_links is also empty (AJAX page):

```
1. web_browse wait(selector: 'a[href]', timeout: 15000)  // wait for load
2. web_browse get_links → retry search
3. If still empty → web_browse scroll(down) 2-3 times → retry get_links
```

### If nothing works:

```
1. web_browse screenshot → see what actually renders
2. web_browse evaluate: document.body.innerHTML.substring(0, 3000) → raw HTML
3. Analyze HTML and look for data-attributes, JSON in <script>, or API calls
```

## CMS-Agnostic Approach

Different CMS use different classes. Don't rely on typical names:

| CMS | Typical product classes |
|-----|------------------------|
| WooCommerce | `.product`, `.woocommerce-loop-product__title` |
| 1C-Bitrix | `.catalog-section-item`, `.product-item` |
| OpenCart | `.product-layout`, `.product-thumb` |
| Shopify | `.product-card`, `.grid-product` |
| WordPress/WPShop | `.product-item`, `.woocommerce` |

**Rule**: always start with `discover` (find links/classes), not with guessing.

## Evaluate: Safe JavaScript

### NodeList is NOT an Array

`querySelectorAll` returns `NodeList` — `.slice()`, `.map()` do **NOT work** on it.

```javascript
// BAD:
document.querySelectorAll('.item').slice(0, 10)

// CORRECT:
Array.from(document.querySelectorAll('.item')).slice(0, 10)
```

### One call — all data

```javascript
// BAD — 10 evaluate calls:
web_browse evaluate: document.querySelectorAll('.item')[0]?.textContent
web_browse evaluate: document.querySelectorAll('.item')[1]?.textContent
// ...

// CORRECT — 1 evaluate:
JSON.stringify(Array.from(document.querySelectorAll('.item')).slice(0, 10).map(el => el.textContent.trim()))
```

### Safe optional chaining

```javascript
// If element might not exist:
el.querySelector('.price')?.textContent?.trim() ?? 'N/A'
// NOT:
el.querySelector('.price').textContent.trim()  // TypeError if null
```

## Common Mistakes (What NOT to do)

### DON'T: extract without knowing the structure

```
# BAD — spending tokens on raw HTML
web_browse extract(format: 'html')
web_browse extract(format: 'text')
web_browse scroll(direction: 'down')  # why?
web_browse scroll(direction: 'down')  # and again?
```

### DON'T: write Node.js scripts for simple tasks

```
# BAD — npm init, npm install, write_file script, syntax error, ...
bash: npm init -y
bash: npm install axios
write_file: parse.js  // SyntaxError: missing /
```

### DON'T: guess selectors without discovering

```
# BAD — trying 5 different selectors blindly
web_browse evaluate: document.querySelectorAll('.product-card').length  // 0
web_browse evaluate: document.querySelectorAll('.item').length  // 0
web_browse evaluate: document.querySelectorAll('.goods').length  // 0
web_browse evaluate: document.querySelectorAll('.product').length  // 0
web_browse evaluate: document.querySelectorAll('.goods-item').length  // 0
# 5 turns wasted!
```

### RIGHT: discover once, then extract

```
# CORRECT — discover → verify → extract
web_browse navigate(url)
web_browse evaluate: JSON.stringify(Array.from(document.querySelectorAll('a[href]')).filter(a => a.href.includes('/product')).slice(0,3).map(a => ({href: a.href, cls: a.closest('div[class]')?.className})))
# → see real classes
web_browse evaluate: document.querySelectorAll('.real_class').length  // 27
web_browse evaluate: JSON.stringify(Array.from(document.querySelectorAll('.real_class')).slice(0,10).map(...))
```

## File Writing Rules

- **1 file per turn**: if you need to create multiple files — use a subagent
- **write_file is blocked** if > 3 files written without subagent
- If write_file is blocked due to syntax error — **rewrite the file entirely**, don't edit
- For large data: first `evaluate` returns JSON, then `write_file` formats the result

## Debugging: If data is not extracted

1. **Check page loaded**: `web_browse evaluate: document.title`
2. **Check structure**: `web_browse evaluate: document.querySelector('body').children.length`
3. **Check specific selector**: `web_browse evaluate: document.querySelectorAll('.your-selector').length`
4. **Look at raw HTML**: `web_browse extract(format: 'html', maxChars: 2000)`
5. **Check for JS errors**: `web_browse evaluate: window.onerror || 'no errors'`

## Quick Reference: Actions

| Action | When to use | Parameters |
|--------|-------------|------------|
| `navigate` | Open a page | `url` |
| `evaluate` | Execute JS, get data | `value` (JS code) |
| `extract` | Get text/html (rarely!) | `selector`, `format`, `maxChars` |
| `click` | Click an element | `selector` |
| `type` | Type text into a field | `selector`, `value` |
| `scroll` | Scroll the page | `direction` |
| `wait` | Wait for element to appear | `selector` or `condition`, `timeout` |
| `get_links` | Get all links | — |
| `discover` | Find all CSS classes + links | — |
| `screenshot` | Screenshot the page | `selector` |
| `close` | Close the browser | — |

## Example: Real Task

**Task**: Scrape 10 bikes from a catalog, save to .md

```
1. web_browse navigate: https://shop.com/bikes
2. web_browse discover
   → see real class names (e.g., ".catalog-item", ".product-layout")
3. web_browse evaluate: document.querySelectorAll('.catalog-item').length
   → "27" (selector is correct)
4. web_browse evaluate: JSON.stringify(Array.from(document.querySelectorAll('.catalog-item')).slice(0, 10).map(el => ({
     name: el.querySelector('.item-title a')?.textContent?.trim(),
     price: el.querySelector('.price')?.textContent?.trim(),
     link: el.querySelector('a')?.href
   })))
   → JSON with 10 products
5. write_file: bikes.md (formatted result)
6. web_browse close
```

**Total: 6 turns** instead of 30+ as in the log above.
