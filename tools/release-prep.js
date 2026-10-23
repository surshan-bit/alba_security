// Prepares a publish of the dashboard artifact from the files `npm run build` made. Run it on `main` after the pull request is merged and
// the build has been run, then hand publish/publish.json to the Artifact tool and write publish/release.json to appMeta/release.
//   node tools/release-prep.js [--since <git ref>]
//     --since  the commit the live artifact was last published from (default: HEAD^1, the previous tip of main). Files that changed since
//              then are published, and chunks that existed then but not now are removed.
// Writes (publish/ is not committed):
//   publish/index.html    the page: index.html from the first <!DOCTYPE html> to the last </body></html>
//   publish/publish.json  { file_path, root, files } for the Artifact tool: changed files, app.js, styles.css, js/loader.js, every chunk, and null for old chunks
//   publish/release.json  { at, build, version } for appMeta/release (so open pages reload once and stop asking)
// Check the live artifact's version id and file list yourself before publishing (see skills/alba-dashboard-release/SKILL.md).
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'publish');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const since = process.argv.includes('--since') ? process.argv[process.argv.indexOf('--since') + 1] : 'HEAD^1';
if(!since || since.startsWith('--')){ console.error('--since needs a git ref'); process.exit(1); }

// Only these kinds of files go to the artifact (the rest of the repo is not part of the page), and never these.
const SENT = [/^(src|styles|partials|types)\//, /^tests\//, /^tools\//, /^(README\.md|package\.json|package-lock\.json|tsconfig\.json)$/];
const REPO_ONLY = [/^tests\/out\//, /^tests\/platform\.mjs$/, /\.gz$/, /^tools\/(dist|export-pack|export-settings)\.js$/, /^tools\/daily-refresh\.mjs$/, /^tools\/alba-/];

fs.mkdirSync(out, { recursive: true });
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const i = html.indexOf('<!DOCTYPE html>'), endTag = '</body></html>', j = html.lastIndexOf(endTag);
if(i < 0 || j < 0){ console.error('index.html has no <!DOCTYPE html> ... </body></html>'); process.exit(1); }
fs.writeFileSync(path.join(out, 'index.html'), html.slice(i, j + endTag.length));

// The build id and version of the page just written (the same check as tools/release-record.js: it fails if they differ).
const record = JSON.parse(execFileSync('node', [path.join(__dirname, 'release-record.js'), path.join(out, 'index.html')], { cwd: root, encoding: 'utf8' }));
const at = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 19) + '+05:30';
fs.writeFileSync(path.join(out, 'release.json'), JSON.stringify({ at, build: record.build, version: record.version }) + '\n');

const files = {};
for(const f of git('diff', '--name-only', since, 'HEAD').split('\n').filter(Boolean)){
  if(!fs.existsSync(path.join(root, f)) || !SENT.some(r => r.test(f)) || REPO_ONLY.some(r => r.test(f))) continue;
  files[f] = f;
}
for(const f of ['app.js', 'styles.css', 'js/loader.js']) files[f] = f;
const chunks = new Set(fs.readdirSync(path.join(root, 'chunks')).map(f => 'chunks/' + f));
chunks.forEach(f => { files[f] = f; });
const before = git('ls-tree', '--name-only', since, 'chunks/').split('\n').filter(Boolean);
before.filter(f => !chunks.has(f)).forEach(f => { files[f] = null; });

fs.writeFileSync(path.join(out, 'publish.json'), JSON.stringify({ file_path: path.join(out, 'index.html'), root, files }, null, 1) + '\n');
const removed = Object.values(files).filter(v => v === null).length;
console.log('release ' + record.version + ' (build ' + record.build + '): ' + (Object.keys(files).length - removed) + ' files to publish, ' + removed + ' old chunks to remove, changes since ' + since);
console.log('publish/index.html, publish/publish.json, publish/release.json written');
