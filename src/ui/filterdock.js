// Analysis and Explorer: on a wide screen the filter column can be hidden. It is closed at first, and what a person chooses is remembered
// for each screen (saved with their other screen state). On a phone the same open/closed flag drives the bottom sheet, so a phone always
// starts closed and never saves a choice: a remembered "open" must not throw a sheet over the page.
import { uiStateGet, uiStateSet } from '../identity/prefs.js';

const onPhone = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 900px)').matches;

// Whether this screen's filters start open (key: where the choice is kept, e.g. 'aFiltersOpen').
function filtersOpenSaved(key){
  return !onPhone() && uiStateGet()[key] === true;
}

// Called whenever the person opens or closes the filters.
function rememberFiltersOpen(key, open){
  if(!onPhone()) uiStateSet({ [key]: !!open }, 400);
}

export { filtersOpenSaved, rememberFiltersOpen };
