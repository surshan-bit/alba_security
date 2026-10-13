// Copies only the files a visitor needs into dist/ (the folder Cloudflare publishes), leaving source, tests and keys out.
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for(const f of ['index.html', 'app.js', 'styles.css', 'js', 'chunks', 'partials']){
  const from = path.join(root, f);
  if(fs.existsSync(from)) fs.cpSync(from, path.join(out, f), { recursive: true });
}
console.log('dist/ ready: ' + fs.readdirSync(out).join(', '));
