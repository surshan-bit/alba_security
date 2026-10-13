// The one classic script on the page. It starts the application (app.js, an ES module built from src/boot/start.js) and puts a
// message on the cover if that cannot be loaded. Everything else lives in src/ as modules, covered by tools/lint.js.
// index.html names the entry in data-entry (with the build id, so a new build is never served from a stale cache).
(function(){
  var me = document.currentScript;
  var url = new URL((me && me.getAttribute('data-entry')) || 'app.js', document.baseURI).href;
  import(url).catch(function(e){
    console.error(e);
    var cover = document.getElementById('bootStatus'), text = cover && cover.querySelector('.boot-msg'), retry = cover && cover.querySelector('.boot-retry');
    if(!text) return;
    var load = /dynamically imported module|importing a module script|failed to fetch/i.test(String((e && e.message) || e));
    cover.hidden = false;
    text.textContent = 'Could not start the dashboard: ' + (load ? 'could not load app.js' : ((e && e.message) || e)) + '.';
    if(retry) retry.hidden = false;
  });
})();
