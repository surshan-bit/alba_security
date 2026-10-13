const fs = require('fs'), path = require('path'), zlib = require('zlib');
const root = path.join(__dirname, 'mine'), docs = {};
(function walk(d){ for(const f of fs.readdirSync(d)){ const p = path.join(d, f); if(fs.statSync(p).isDirectory()) walk(p); else docs[path.relative(root, p).replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(p, 'utf8')); } })(root);
fs.writeFileSync(path.join(__dirname, 'alba-my-settings.json.gz'), zlib.gzipSync(JSON.stringify({ format: 'alba-docs-v1', exportedAt: new Date().toISOString(), docs })));
console.log(Object.keys(docs));
