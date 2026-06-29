// Persistent registry of "setups" — named, daemonized tethers. Each setup
// remembers its room code and agent command so the phone can reconnect anytime
// and the service can run it headless on boot.
//
// Stored as JSON under the OS config dir. Secrets (the OpenAI key) go in a
// sibling per-setup env file with tight permissions, never in the JSON.

import { mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function configDir() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'bridle');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'bridle');
}

const setupsFile = () => join(configDir(), 'setups.json');
export const envFileFor = (name) => join(configDir(), `${safeName(name)}.env`);

export function safeName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default';
}

async function ensureDir() {
  await mkdir(configDir(), { recursive: true });
}

export async function readSetups() {
  try {
    const raw = await readFile(setupsFile(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function getSetup(name) {
  const all = await readSetups();
  return all[safeName(name)] || null;
}

/**
 * @param {{name:string, room:string, agent:string[], cwd:string, backendUrl:string, createdAt?:string}} setup
 */
export async function saveSetup(setup) {
  await ensureDir();
  const all = await readSetups();
  const key = safeName(setup.name);
  all[key] = { ...all[key], ...setup, name: key };
  await writeFile(setupsFile(), JSON.stringify(all, null, 2));
  return all[key];
}

export async function removeSetup(name) {
  const key = safeName(name);
  const all = await readSetups();
  if (!all[key]) return false;
  delete all[key];
  await writeFile(setupsFile(), JSON.stringify(all, null, 2));
  try {
    await rm(envFileFor(key), { force: true });
  } catch {
    /* env file may not exist */
  }
  return true;
}

/** Write the per-setup secret env file (0600). */
export async function writeEnvFile(name, env) {
  await ensureDir();
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
