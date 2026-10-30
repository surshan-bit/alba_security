// The look of the app: there is one design (the White theme, set on <html data-theme="white"> in index.html).
// The logo font (Quicksand from Google Fonts) is added after the first paint, as a plain <link> in index.html it held up the first paint of every page.
function ensureBrandFont(){
  if(document.getElementById('brandFont')) return;
  const link = document.createElement('link');
  link.id = 'brandFont'; link.rel = 'stylesheet'; link.href = 'https://fonts.googleapis.com/css2?family=Quicksand:wght@700&display=swap';
  document.head.appendChild(link);
}

function init_ui_theme(){
  ensureBrandFont();
}

export { init_ui_theme };
