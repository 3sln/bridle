// Persistent registry backed by SQLite (bun:sqlite, WAL). One `bridle.db` under
// the OS config dir holds the mutable state the server owns and the CLI reads —
// tethers, device pins, live status, and which sessions have been primed. SQLite
// gives atomic, concurrent-safe access (the server rewrites status constantly
// while `bridle list` reads it), which JSON files couldn't.
//
// A tiny `tethers.touch` marker is bumped on every tether change so the server's
// fs.watch still picks up new/removed tethers in ~instantly. Secrets live in
// per-tether `.env` files (0600), and process liveness uses PID-file locks —
// neither belongs in the DB.

import { writeFile, rm, chmod } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Database } from 'bun:sqlite';

export function configDir() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'bridle');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'bridle');
}

export const envFileFor = (name) => join(configDir(), `${safeName(name)}.env`);
const touchFile = () => join(configDir(), 'tethers.touch');

export function safeName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default';
}

// --- database ---------------------------------------------------------------
let _db = null;
function db() {
  if (_db) return _db;
  mkdirSync(configDir(), { recursive: true });
  _db = new Database(join(configDir(), 'bridle.db'), { create: true });
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA busy_timeout = 3000');
  _db.exec(`CREATE TABLE IF NOT EXISTS tethers (
    name TEXT PRIMARY KEY, room TEXT, agent TEXT, cwd TEXT, backend_url TEXT, created_at TEXT
  )`);
  _db.exec('CREATE TABLE IF NOT EXISTS pins (token TEXT PRIMARY KEY, fingerprint TEXT)');
  _db.exec(`CREATE TABLE IF NOT EXISTS status (
    name TEXT PRIMARY KEY, phase TEXT, guest TEXT, agent_state TEXT, room TEXT, at INTEGER
  )`);
  _db.exec('CREATE TABLE IF NOT EXISTS seeded (session_id TEXT PRIMARY KEY, at INTEGER)');
  _db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  migrateFromJson(_db);
  return _db;
}

// One-time import of the pre-SQLite JSON files (tethers.json/setups.json/pins.json).
function migrateFromJson(d) {
  if (d.query("SELECT value FROM meta WHERE key = 'schema'").get()) return;
  for (const f of ['tethers.json', 'setups.json']) {
    try {
      const obj = JSON.parse(readFileSync(join(configDir(), f), 'utf8'));
      const ins = d.query('INSERT OR IGNORE INTO tethers (name, room, agent, cwd, backend_url, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const [name, s] of Object.entries(obj)) {
        ins.run(name, s.room ?? null, JSON.stringify(s.agent ?? null), s.cwd ?? null, s.backendUrl ?? null, s.createdAt ?? null);
      }
      break; // prefer the newer file; import only one
    } catch {
      /* not present */
    }
  }
  try {
    const pins = JSON.parse(readFileSync(join(configDir(), 'pins.json'), 'utf8'));
    const ins = d.query('INSERT OR IGNORE INTO pins (token, fingerprint) VALUES (?, ?)');
    for (const [t, fp] of Object.entries(pins)) ins.run(t, fp);
  } catch {
    /* not present */
  }
  d.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', '1')").run();
}

const rowToSetup = (r) => ({
  name: r.name,
  room: r.room,
  agent: r.agent ? JSON.parse(r.agent) : null,
  cwd: r.cwd,
  backendUrl: r.backend_url,
  createdAt: r.created_at,
});

function allSetups() {
  const map = {};
  for (const r of db().query('SELECT * FROM tethers').all()) map[r.name] = rowToSetup(r);
  return map;
}

// Bump the watch marker so the server reconciles right away.
function touchTethers() {
  try {
    writeFileSync(touchFile(), String(Date.now()));
  } catch {
    /* the server's poll backstop still catches it */
  }
}

// --- tethers ----------------------------------------------------------------
export async function readSetups() {
  return allSetups();
}
/** Sync read for hot paths (server watch/status) that can't await. */
export function readSetupsSync() {
  return allSetups();
}
export async function getSetup(name) {
  const r = db().query('SELECT * FROM tethers WHERE name = ?').get(safeName(name));
  return r ? rowToSetup(r) : null;
}

/**
 * Persist a tether. Re-pairing the same directory updates it in place; a
 * different directory naming a colliding tether gets a fresh suffixed key so
 * neither clobbers the other.
 * @param {{name:string, room:string, agent:object, cwd:string, backendUrl:string, createdAt?:string}} setup
 */
export async function saveSetup(setup) {
  const d = db();
  let key = safeName(setup.name);
  if (setup.cwd) {
    for (;;) {
      const existing = d.query('SELECT cwd FROM tethers WHERE name = ?').get(key);
      if (!existing || !existing.cwd || existing.cwd === setup.cwd) break;
      const m = key.match(/^(.*?)-(\d+)$/);
      key = m ? `${m[1]}-${Number(m[2]) + 1}` : `${key}-2`;
    }
  }
  const prev = d.query('SELECT * FROM tethers WHERE name = ?').get(key);
  const merged = { ...(prev ? rowToSetup(prev) : {}), ...setup, name: key, cwd: setup.cwd ?? prev?.cwd ?? null };
  d.query(
    `INSERT INTO tethers (name, room, agent, cwd, backend_url, created_at) VALUES ($n, $r, $a, $c, $b, $t)
     ON CONFLICT(name) DO UPDATE SET room=$r, agent=$a, cwd=$c, backend_url=$b, created_at=$t`,
  ).run({
    $n: key,
    $r: merged.room ?? null,
    $a: JSON.stringify(merged.agent ?? null),
    $c: merged.cwd ?? null,
    $b: merged.backendUrl ?? null,
    $t: merged.createdAt ?? null,
  });
  touchTethers();
  return merged;
}

export async function removeSetup(name) {
  const d = db();
  const key = safeName(name);
  const row = d.query('SELECT room FROM tethers WHERE name = ?').get(key);
  if (!row) return false;
  d.query('DELETE FROM tethers WHERE name = ?').run(key);
  d.query('DELETE FROM status WHERE name = ?').run(key);
  if (row.room) {
    await removePin(row.room).catch(() => {});
  }
  try {
    await rm(envFileFor(key), { force: true });
  } catch {
    /* env file may not exist */
  }
  touchTethers();
  return true;
}

// --- device pins (TOFU) -----------------------------------------------------
// Map a tether's token (room) to the fingerprint of the phone we paired with, so
// a leaked token alone can't drive the agent once a device is pinned.
export async function getPin(token) {
  return db().query('SELECT fingerprint FROM pins WHERE token = ?').get(token)?.fingerprint || null;
}
export async function savePin(token, fingerprint) {
  db().query('INSERT OR REPLACE INTO pins (token, fingerprint) VALUES (?, ?)').run(token, fingerprint);
}
export async function removePin(token) {
  db().query('DELETE FROM pins WHERE token = ?').run(token);
}

// --- primed sessions --------------------------------------------------------
// Whether a given agent session has already been given the bridle voice primer,
// so reconnecting to or resuming a session never re-primes it.
export function isSeeded(sessionId) {
  if (!sessionId) return false;
  return !!db().query('SELECT 1 FROM seeded WHERE session_id = ?').get(sessionId);
}
export function markSeeded(sessionId) {
  if (!sessionId) return;
  db().query('INSERT OR IGNORE INTO seeded (session_id, at) VALUES (?, ?)').run(sessionId, Date.now());
}

// --- live status (server -> CLI) --------------------------------------------
// The server replaces the full status snapshot; entries older than
// STATUS_STALE_MS (and only while the server is up) count as live.
export const STATUS_STALE_MS = 15000;

export function writeStatus(map) {
  try {
    const d = db();
    const write = d.transaction((entries) => {
      d.query('DELETE FROM status').run();
      const ins = d.query('INSERT INTO status (name, phase, guest, agent_state, room, at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const [name, s] of entries) ins.run(name, s.phase ?? null, s.guest ?? null, s.agentState ?? null, s.room ?? null, s.at ?? Date.now());
    });
    write(Object.entries(map));
  } catch {
    /* status is best-effort */
  }
}
export function readStatusSync() {
  try {
    const out = {};
    for (const r of db().query('SELECT * FROM status').all()) {
      out[r.name] = { phase: r.phase, guest: r.guest, agentState: r.agent_state, room: r.room, at: r.at };
    }
    return out;
  } catch {
    return {};
  }
}

// --- per-tether secret env file (0600) --------------------------------------
export async function writeEnvFile(name, env) {
  mkdirSync(configDir(), { recursive: true });
  const path = envFileFor(name);
  const body = Object.entries(env)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  await writeFile(path, body + '\n');
  if (process.platform !== 'win32') {
    try {
      await chmod(path, 0o600);
    } catch {
      /* best effort */
    }
  }
  return path;
}
export const hasEnvFile = (name) => existsSync(envFileFor(name));

// --- legacy per-tether daemon lock (PID file) -------------------------------
// Kept for the back-compat `daemon --setup` path; the shared server uses its own
// lock below. A stale file (dead PID) is ignored so a crash never wedges a tether.
const lockFile = (name) => join(configDir(), `${safeName(name)}.pid`);

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but not signalable == alive
  }
}

export function daemonRunning(name) {
  try {
    return pidAlive(Number(readFileSync(lockFile(name), 'utf8').trim()));
  } catch {
    return false;
  }
}
export function acquireDaemonLock(name) {
  if (daemonRunning(name)) return false;
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(lockFile(name), String(process.pid));
    return true;
  } catch {
    return true; // can't write a lock — proceed rather than block the tether
  }
}
export function releaseDaemonLock(name) {
  try {
    if (Number(readFileSync(lockFile(name), 'utf8').trim()) === process.pid) {
      rmSync(lockFile(name), { force: true });
    }
  } catch {
    /* nothing to release */
  }
}
/** Migration: stop a still-running legacy per-tether daemon and clear its lock. */
export function stopLegacyDaemon(name) {
  try {
    const pid = Number(readFileSync(lockFile(name), 'utf8').trim());
    if (pidAlive(pid)) {
      try {
        process.kill(pid);
      } catch {
        /* already gone / not ours */
      }
    }
    rmSync(lockFile(name), { force: true });
  } catch {
    /* no legacy lock */
  }
}

// --- shared server: single-instance lock (PID file) -------------------------
const serverLockFile = () => join(configDir(), 'server.pid');

export function serverRunning() {
  try {
    return pidAlive(Number(readFileSync(serverLockFile(), 'utf8').trim()));
  } catch {
    return false;
  }
}
export function acquireServerLock() {
  if (serverRunning()) return false;
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(serverLockFile(), String(process.pid));
    return true;
  } catch {
    return true;
  }
}
export function releaseServerLock() {
  try {
    if (Number(readFileSync(serverLockFile(), 'utf8').trim()) === process.pid) {
      rmSync(serverLockFile(), { force: true });
    }
  } catch {
    /* nothing to release */
  }
}
/** Stop the running shared server and its whole process tree, then clear the lock. */
export function stopServer() {
  let pid;
  try {
    pid = Number(readFileSync(serverLockFile(), 'utf8').trim());
  } catch {
    return false;
  }
  if (pid && pidAlive(pid)) {
    try {
      if (process.platform === 'win32') {
        Bun.spawnSync(['taskkill', '/PID', String(pid), '/T', '/F']); // tree: server + agents
      } else {
        process.kill(pid, 'SIGTERM');
      }
    } catch {
      /* already gone */
    }
  }
  try {
    rmSync(serverLockFile(), { force: true });
  } catch {
    /* noop */
  }
  return true;
}
