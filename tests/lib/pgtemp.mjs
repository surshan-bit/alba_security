// A throw-away PostgreSQL server for the database tests (tests/rls.mjs): its own data folder, reachable only through a socket in that folder
// (no network port), removed again at the end. Uses the PostgreSQL programs already on the machine (GitHub's Ubuntu runners have them);
// start() answers null when there are none, so the caller decides between skipping and failing.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SUPERUSER = 'postgres';

// The folder holding initdb and pg_ctl: PG_BIN if set, else the newest /usr/lib/postgresql/<version>/bin.
function findBin(){
  const candidates = [];
  if(process.env.PG_BIN) candidates.push(process.env.PG_BIN);
  const root = '/usr/lib/postgresql';
  if(existsSync(root)) candidates.push(...readdirSync(root).sort((a, b) => Number(b) - Number(a)).map(v => join(root, v, 'bin')));
  return candidates.find(dir => existsSync(join(dir, 'initdb')) && existsSync(join(dir, 'pg_ctl'))) || null;
}

// PostgreSQL refuses to run as root, so a root shell (a container) hands the server to the "postgres" account.
function serverRunner(dir){
  if(!(process.getuid && process.getuid() === 0)) return (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' });
  execFileSync('chown', [SUPERUSER, dir]);
  return (cmd, args) => execFileSync('su', [SUPERUSER, '-s', '/bin/sh', '-c', [cmd, ...args].map(a => `'${a}'`).join(' ')], { stdio: 'pipe' });
}

/** @returns {{ run: (db: string, sql: string) => { ok: boolean, out: string, err: string }, runFile: (db: string, file: string) => { ok: boolean, out: string, err: string }, createDb: (name: string) => void, stop: () => void } | null} */
export function startPostgres(){
  const bin = findBin();
  if(!bin) return null;
  const dir = mkdtempSync(join(tmpdir(), 'alba-pg-'));
  chmodSync(dir, 0o755);
  const asServer = serverRunner(dir), data = join(dir, 'data');
  const stop = () => {
    try { asServer(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', 'stop']); } catch(e){ /* it never started, or already stopped */ }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    asServer(join(bin, 'initdb'), ['-D', data, '-A', 'trust', '-U', SUPERUSER]);
    // listen_addresses empty: no TCP at all, only the socket in `dir`
    asServer(join(bin, 'pg_ctl'), ['-D', data, '-o', `-c listen_addresses= -k ${dir} -c fsync=off`, '-w', '-l', join(dir, 'server.log'), 'start']);
  } catch(e){ stop(); throw e; }
  const psql = (db, args) => {
    const r = spawnSync(join(bin, 'psql'), ['-h', dir, '-U', SUPERUSER, '-d', db, '-v', 'ON_ERROR_STOP=1', '-At', '-q', ...args], { encoding: 'utf8' });
    return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
  };
  return {
    run: (db, sql) => psql(db, ['-c', sql]),
    runFile: (db, file) => psql(db, ['-f', file]),
    createDb: (name) => { const r = psql('postgres', ['-c', `create database ${name}`]); if(!r.ok) throw new Error(r.err); },
    stop
  };
}
