const fs = require('fs'), path = require('path'), zlib = require('zlib');
const dir = path.join(__dirname, 'export'), docs = {};
for(const col of fs.readdirSync(dir)) for(const f of fs.readdirSync(path.join(dir, col))){
  const id = f.replace(/\.json$/, ''); const data = JSON.parse(fs.readFileSync(path.join(dir, col, f), 'utf8'));
  docs[col + '/' + id] = data;
}
const json = JSON.stringify({ format: 'alba-docs-v1', exportedAt: new Date().toISOString(), docs });
fs.writeFileSync(path.join(__dirname, 'alba-data.json.gz'), zlib.gzipSync(json, { level: 9 }));
console.log(Object.keys(docs).length, 'docs', (json.length / 1e6).toFixed(1), 'MB json', (fs.statSync(path.join(__dirname, 'alba-data.json.gz')).size / 1e6).toFixed(1), 'MB gz');
