// JS-сниппеты для действий в странице: клик, ввод, скролл, разметка, извлечение текста.
/** JS для клика по элементу с индексом из снапшота. */
export function buildClickScript(elementIndex: number): string {
  return `
    const el = document.querySelector('[data-browser-index="${elementIndex}"]');
    if (!el) throw new Error('Element not found: ${elementIndex}');
    el.click();
  `;
}

/** JS для ввода текста в поле: фокус, установка значения, события input/change. */
export function buildTypeScript(elementIndex: number, text: string): string {
  const escaped = JSON.stringify(text);
  return `
    const el = document.querySelector('[data-browser-index="${elementIndex}"]');
    if (!el) throw new Error('Element not found: ${elementIndex}');
    const text = JSON.parse(${JSON.stringify(escaped)});
    el.focus();
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  `;
}

/** JS для прокрутки страницы в заданном направлении. */
export function buildScrollScript(direction: "up" | "down" | "top" | "bottom"): string {
  switch (direction) {
    case "down":
      return `window.scrollBy({ top: 600, behavior: 'smooth' })`;
    case "up":
      return `window.scrollBy({ top: -600, behavior: 'smooth' })`;
    case "top":
      return `window.scrollTo({ top: 0, behavior: 'smooth' })`;
    case "bottom":
      return `window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })`;
  }
}

/** JS для простановки интерактивным элементам атрибутов data-browser-index. */
export function buildIndexInjectionScript(): string {
  return `
    const selectors = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [contenteditable="true"]';
    const elements = document.querySelectorAll(selectors);
    let idx = 1;
    elements.forEach(el => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      el.setAttribute('data-browser-index', String(idx++));
    });
  `;
}

/** JS для извлечения видимого текстового содержимого страницы построчно. */
export function buildTextExtractionScript(): string {
  return `
    const contentTags = new Set(['h1','h2','h3','h4','h5','h6','p','li','article','main','section','blockquote','pre','td','th','dt','dd','figcaption']);
    const out = [];
    const seen = new Set();
    const isHidden = (el) => {
      const st = window.getComputedStyle(el);
      return st.display === 'none' || st.visibility === 'hidden';
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => {
        const tag = node.tagName ? node.tagName.toLowerCase() : '';
        if (!contentTags.has(tag)) return NodeFilter.FILTER_SKIP;
        if (isHidden(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      const tag = node.tagName.toLowerCase();
      const text = (node.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!text) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      const line = text.length > 200 ? text.slice(0, 200) + '…' : text;
      out.push('[' + tag + '] ' + line);
    }
    return out.join('\\n');
  `;
}
