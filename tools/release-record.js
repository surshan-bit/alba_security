// Prints the release record to store in appMeta/release after a publish, read from the index.html that was just built.
// Run it AFTER the last `npm run check` / `npm run build` (each re-stamps the build id), and compare with the published page:
//   node tools/release-record.js            -> {"build":"1d01f803","version":"v1.165"}
//   node tools/release-record.js live.html  -> the same, but also fails when live.html (the published index.html) carries a different build id
// A record whose build differs from the published page makes every open tab reload once and then show "A new version is available".
const fs = require('fs');
const build = (t) => { const m = /<script src="js\/loader\.js" data-entry="app\.js\?v=([0-9a-f]+)"/.exec(t); return m ? m[1] : null; };
const idx = fs.readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
const mine = build(idx), ver = /class="brand-version"[^>]*>(v[0-9.]+)</.exec(idx);
if(!mine || !ver){ console.error('index.html has no build id or version badge'); process.exit(1); }
if(process.argv[2]){
  const live = build(fs.readFileSync(process.argv[2], 'utf8'));
  if(live !== mine){ console.error('MISMATCH: the published page has build ' + live + ' but index.html has ' + mine + '. Publish again from the latest build.'); process.exit(1); }
}
console.log(JSON.stringify({ build: mine, version: ver[1] }));
