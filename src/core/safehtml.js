// The one place where markup text becomes page elements (CLAUDE.md section 3). Pages are drawn from HTML strings, and a string can carry saved or
// imported text that was not escaped. Every string goes through here instead of `innerHTML`, so a missed escape cannot start a script:
// the markup is parsed by the element's own window in an inert document (nothing loads, no handler fires), then script-capable parts are removed before the elements
// reach the page. This is a safety net, not a replacement for escapeHtml: escape every value that goes into markup.
const SVG_NS = 'http://www.w3.org/2000/svg';
// Elements that run code, load other documents or restyle the page. Styles belong in the global stylesheet, so <style> is blocked too.
const BLOCKED = new Set(['SCRIPT', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET', 'BASE', 'META', 'LINK', 'STYLE', 'TEMPLATE', 'NOSCRIPT',
  'FOREIGNOBJECT', 'ANIMATE', 'ANIMATEMOTION', 'ANIMATETRANSFORM', 'SET']);
const BLOCKED_ATTRIBUTES = new Set(['srcdoc', 'formaction']);
const URL_ATTRIBUTES = new Set(['href', 'src', 'xlink:href', 'action', 'poster', 'background', 'data', 'ping']);
const SAFE_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:'];
const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);/;
// Characters a browser ignores inside a URL scheme ("java\tscript:"): removed before the scheme is read.
const URL_NOISE = /[\u0000-\u0020\u00a0\u1680\u180e\u2000-\u2029\u205f\u3000]/g;

/** @param {string} value @param {string} attribute @returns {boolean} true when a link or source value is safe to keep */
function isSafeUrl(value, attribute) {
  const url = value.replace(URL_NOISE, '').toLowerCase();
  const scheme = /^[a-z][a-z0-9+.-]*:/.exec(url);
  if (!scheme) return true;   // relative, "#anchor" or "/path"
  if (SAFE_SCHEMES.includes(scheme[0])) return true;
  return attribute === 'src' && SAFE_DATA_IMAGE.test(url);
}

/** @param {Element} el removes what must not reach the page from one element */
function cleanElement(el) {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith('on') || BLOCKED_ATTRIBUTES.has(name) || (URL_ATTRIBUTES.has(name) && !isSafeUrl(attr.value, name))) el.removeAttribute(attr.name);
  }
}

/** @param {DocumentFragment | Element} root removes blocked elements and unsafe attributes from everything under `root` */
function clean(root) {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (BLOCKED.has(el.tagName.toUpperCase())) el.remove();
    else cleanElement(el);
  }
}

/**
 * Turns markup text into a clean fragment, ready to insert.
 * @param {string} html the markup
 * @param {Element} anchor an element of the page the markup is for: its window parses the text
 * @param {Element | null} [context] where the markup will go (default: the anchor): markup for an SVG element is parsed as SVG, not as HTML
 * @returns {DocumentFragment}
 */
function htmlFragment(html, anchor, context = anchor) {
  const inSvg = !!context && context.namespaceURI === SVG_NS && context.localName !== 'foreignObject';
  const Parser = /** @type {Window & typeof globalThis} */ (anchor.ownerDocument.defaultView).DOMParser;
  // DOMParser documents are inert; a <template> parses table rows (<tr>, <td>) and <option> where a plain element would drop them.
  const doc = new Parser().parseFromString('<!doctype html><body><template>' + (inSvg ? '<svg>' + html + '</svg>' : html) + '</template>', 'text/html');
  const content = /** @type {HTMLTemplateElement} */ (doc.querySelector('template')).content;
  let fragment = content;
  if (inSvg) {
    fragment = content.ownerDocument.createDocumentFragment();
    const wrapper = content.firstChild;
    while (wrapper && wrapper.firstChild) fragment.appendChild(wrapper.firstChild);
  }
  clean(fragment);
  return fragment;
}

/** Replaces the content of `el` with the markup, the safe way to set the HTML of an element.
 * @param {Element | null} el @param {string} html */
function setHtml(el, html) {
  if (!el) throw new TypeError('setHtml: there is no element to fill');
  el.replaceChildren(htmlFragment(html, el));
}

/** Replaces `el` itself with the markup, the safe way to set the outer HTML of an element.
 * @param {Element | null} el @param {string} html */
function replaceWithHtml(el, html) {
  if (!el) throw new TypeError('replaceWithHtml: there is no element to replace');
  el.replaceWith(htmlFragment(html, el, el.parentElement));
}

/** Adds the markup inside `el` at its end, the safe way to add markup at the end of an element.
 * @param {Element | null} el @param {string} html */
function appendHtml(el, html) {
  if (!el) throw new TypeError('appendHtml: there is no element to add to');
  el.append(htmlFragment(html, el));
}

/** Adds the markup right after `el`, the safe way to add markup right after an element.
 * @param {Element | null} el @param {string} html */
function insertHtmlAfter(el, html) {
  if (!el) throw new TypeError('insertHtmlAfter: there is no element to insert after');
  el.after(htmlFragment(html, el, el.parentElement));
}

export { appendHtml, insertHtmlAfter, replaceWithHtml, setHtml };
