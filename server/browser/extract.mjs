/**
 * The page reader.
 *
 * A screenshot is not something ZERO can reason over, and raw `document.body.innerText`
 * is mostly navigation. This is the script that runs *inside* the page and
 * returns what is actually on it: the title, the main article text and the
 * links. It is plain DOM work — it scores block containers by how much of
 * their text is not inside a link, which is what separates an article from a
 * navigation column.
 *
 * The same script runs under both protocols: CDP evaluates it through
 * `Runtime.evaluate`, WebDriver BiDi through `script.evaluate`.
 */

const NOISE = 'script,style,noscript,template,svg,iframe,nav,footer,header,aside,form,button';

/**
 * Builds the expression to evaluate in the page.
 * `maxChars` bounds the returned text, `maxLinks` the returned links.
 */
export function extractionExpression({ maxChars = 12_000, maxLinks = 60 } = {}) {
  return `(() => {
  const NOISE = ${JSON.stringify(NOISE)};
  const MAX_CHARS = ${Number(maxChars)};
  const MAX_LINKS = ${Number(maxLinks)};

  const clean = (value) => String(value || '').replace(/[ \\t\\u00a0]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();

  // innerText is layout-aware, which is what puts a line break between a
  // heading and the paragraph under it. A detached clone has no layout, so
  // the noise is hidden in place and restored again instead of cloned away.
  const textOf = (element) => {
    if (!element) return '';
    const hidden = [];
    for (const node of element.querySelectorAll(NOISE)) {
      hidden.push([node, node.style ? node.style.display : null]);
      if (node.style) node.style.display = 'none';
    }
    let text;
    try {
      text = clean(element.innerText || element.textContent || '');
    } finally {
      for (const [node, previous] of hidden) {
        if (node.style) node.style.display = previous ?? '';
      }
    }
    return text;
  };

  // Link density separates an article from a navigation column: the score is
  // the text that is *not* inside a link.
  const score = (element) => {
    const total = (element.innerText || '').length;
    if (total < 140) return 0;
    let linked = 0;
    for (const anchor of element.querySelectorAll('a')) linked += (anchor.innerText || '').length;
    return total - linked * 1.6;
  };

  let best = document.body;
  let bestScore = best ? score(best) : 0;
  const candidates = document.querySelectorAll('article, main, [role="main"], section, div');
  for (const candidate of candidates) {
    const value = score(candidate);
    if (value > bestScore) {
      best = candidate;
      bestScore = value;
    }
  }

  const text = textOf(best) || textOf(document.body);
  const seen = new Set();
  const links = [];
  const scope = best && best.querySelectorAll('a[href]').length > 0 ? best : document;
  for (const anchor of scope.querySelectorAll('a[href]')) {
    if (links.length >= MAX_LINKS) break;
    let href;
    try { href = new URL(anchor.getAttribute('href'), document.baseURI).href; } catch { continue; }
    if (!/^https?:/.test(href) || seen.has(href)) continue;
    const label = clean(anchor.innerText || anchor.getAttribute('aria-label') || anchor.title || '');
    if (label.length === 0) continue;
    seen.add(href);
    links.push({ text: label.slice(0, 200), href });
  }

  const description = document.querySelector('meta[name="description"], meta[property="og:description"]');

  return {
    url: location.href,
    title: clean(document.title),
    description: clean(description && description.getAttribute('content')),
    text: text.slice(0, MAX_CHARS),
    truncated: text.length > MAX_CHARS,
    characters: text.length,
    links,
  };
})()`;
}
