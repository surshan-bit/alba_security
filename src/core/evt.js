// Typed views of an event's target, so the type check knows which DOM members it has. These are casts only: nothing changes at run time.
const targetEl = (e) => /** @type {HTMLInputElement} */ (e.target);
const closestEl = (e, selector) => /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest(selector));

export { closestEl, targetEl };
