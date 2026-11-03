// The two full-screen pages shown before the app: the sign-in screen and the owner's import screen. Pure DOM builders (no network,
// no globals): they take the document, return the page and the nodes the caller wires up. All styling is in styles/gate.css.

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {string} className
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(doc, tag, className, text){
  const node = doc.createElement(tag);
  node.className = className;
  if(text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {Document} doc
 * @returns {{ page: HTMLElement, button: HTMLButtonElement, message: HTMLElement }}
 */
export function buildSignInPage(doc){
  const page = el(doc, 'div', 'gate'), card = el(doc, 'div', 'gate__card gate__card--narrow');
  const button = /** @type {HTMLButtonElement} */ (el(doc, 'button', 'gate__button gate__button--wide', 'Continue with Google'));
  button.type = 'button';
  const message = el(doc, 'p', 'gate__message');
  page.id = 'albaSignIn';
  button.id = 'albaGoogle';
  message.id = 'albaSignInMsg';
  card.append(el(doc, 'div', 'gate__eyebrow', 'Alba Securities'), el(doc, 'h1', 'gate__title', 'Stock Analyzer'),
    el(doc, 'p', 'gate__text gate__text--spaced', 'Sign in with your Gmail account to open your dashboard.'), button, message);
  page.append(card);
  return { page, button, message };
}

/**
 * @param {Document} doc
 * @returns {{ page: HTMLElement, file: HTMLInputElement, button: HTMLButtonElement, log: HTMLElement }}
 */
export function buildImportPage(doc){
  const page = el(doc, 'div', 'gate gate--scroll'), card = el(doc, 'div', 'gate__card gate__card--wide');
  const file = /** @type {HTMLInputElement} */ (el(doc, 'input', 'gate__file'));
  const button = /** @type {HTMLButtonElement} */ (el(doc, 'button', 'gate__button', 'Import'));
  const log = el(doc, 'pre', 'gate__log');
  const intro = el(doc, 'p', 'gate__text');
  const fileName = el(doc, 'b', '', 'alba-data.json.gz');
  file.type = 'file';
  file.accept = '.gz,.json';
  file.id = 'impFile';
  button.type = 'button';
  button.id = 'impGo';
  log.id = 'impLog';
  intro.append('Choose the data file (', fileName, ') and press Import. Existing documents with the same name are replaced.');
  card.append(el(doc, 'h1', 'gate__title gate__title--small', 'Import stock data (owner only)'), intro, file, button, log);
  page.append(card);
  return { page, file, button, log };
}
