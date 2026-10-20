// Builds dist/, the folder Cloudflare publishes: only what a visitor needs (no source, tests or keys).
// platform.js (the sign-in front door, bundled with the Supabase client) starts first and then loads app.js.
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for(const f of ['index.html', 'app.js', 'styles.css', 'js', 'chunks', 'partials']){
  const from = path.join(root, f);
  if(fs.existsSync(from)) fs.cpSync(from, path.join(out, f), { recursive: true });
}
fs.copyFileSync(path.join(root, 'platform', '_headers'), path.join(out, '_headers'));
let html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
const m = html.match(/data-entry="app\.js\?v=([^"]+)"/);
if(!m){ console.error('dist: index.html has no data-entry="app.js?v=..." to redirect'); process.exit(1); }
require('esbuild').buildSync({
  entryPoints: [path.join(root, 'platform/boot.js')], bundle: true, format: 'esm', minify: true, outfile: path.join(out, 'platform.js'),
  define: { __ALBA_BUILD__: JSON.stringify(m[1]) }, legalComments: 'none', logLevel: 'warning'
});
html = html.replace(m[0], 'data-entry="platform.js?v=' + m[1] + '"');
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log('dist/ ready: ' + fs.readdirSync(out).join(', '));
