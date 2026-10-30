// Small line icons shown in front of the stock page's section headings (they take the heading's colour).
const PATHS = {
  val: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"></path><circle cx="7.5" cy="7.5" r="1.5"></circle>',
  global: '<circle cx="12" cy="12" r="9"></circle><path d="M3 12h18"></path><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"></path>',
  fund: '<path d="M3 21h18"></path><path d="M5 21V10"></path><path d="M10 21V4"></path><path d="M15 21v-8"></path><path d="M20 21V7"></path>',
  tech: '<path d="M3 17l6-6 4 4 8-8"></path><path d="M15 7h6v6"></path>',
  events: '<rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M3 10h18M8 3v4M16 3v4"></path>',
  peers: '<circle cx="9" cy="8" r="3.2"></circle><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"></path><circle cx="17.5" cy="9" r="2.5"></circle><path d="M17 14.2c2.4.3 4.2 2.3 4.2 4.8"></path>'
};
function panelIcon(name){
  return '<svg class="hd-ico" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + PATHS[name] + '</svg>';
}
// The same-sized icon in front of each link under the stock's name (open in a new tab).
const LINK_ICON = '<svg class="link-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><path d="M15 3h6v6"></path><line x1="10" y1="14" x2="21" y2="3"></line></svg>';
export { LINK_ICON, panelIcon };
