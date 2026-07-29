export function buildClickScript(elementIndex: number): string {
  return `
    const el = document.querySelector('[data-browser-index="${elementIndex}"]');
    if (!el) throw new Error('Element not found: ${elementIndex}');
    el.click();
  `
}

export function buildTypeScript(elementIndex: number, text: string): string {
  const escaped = JSON.stringify(text)
  return `
    const el = document.querySelector('[data-browser-index="${elementIndex}"]');
    if (!el) throw new Error('Element not found: ${elementIndex}');
    const text = JSON.parse(${JSON.stringify(escaped)});
    el.focus();
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  `
}

export function buildScrollScript(direction: 'up' | 'down' | 'top' | 'bottom'): string {
  switch (direction) {
    case 'down':
      return `window.scrollBy({ top: 600, behavior: 'smooth' })`
    case 'up':
      return `window.scrollBy({ top: -600, behavior: 'smooth' })`
    case 'top':
      return `window.scrollTo({ top: 0, behavior: 'smooth' })`
    case 'bottom':
      return `window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })`
  }
}

export function buildWaitScript(timeoutMs: number): string {
  return `await new Promise(r => setTimeout(r, ${timeoutMs}))`
}

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
  `
}
