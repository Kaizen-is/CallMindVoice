#!/usr/bin/env node
/**
 * Ovoz — reset the local datastore.
 *
 * Deletes the SQLite database (and its WAL/SHM sidecars) plus every uploaded
 * file, so the next boot starts from empty migrations. Pure node:fs, no deps.
 *
 *   npm run reset          # wipe the database + uploads, keep the session secret
 *   npm run reset -- --all # also delete data/.secret (new signing key next boot)
 *
 * Only ever touches the project's own `data/` directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const alsoSecret = process.argv.includes('--all');

if (!fs.existsSync(dataDir)) {
  console.log('Nothing to reset — data/ does not exist yet.');
  process.exit(0);
}

const removed = [];
const targets = ['ovoz.db', 'ovoz.db-wal', 'ovoz.db-shm'];
if (alsoSecret) targets.push('.secret');

for (const name of targets) {
  const p = path.join(dataDir, name);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { force: true });
    removed.push(name);
  }
}

const uploads = path.join(dataDir, 'uploads');
if (fs.existsSync(uploads)) {
  const files = fs.readdirSync(uploads);
  fs.rmSync(uploads, { recursive: true, force: true });
  fs.mkdirSync(uploads, { recursive: true });
  if (files.length) removed.push(`uploads/ (${files.length} file${files.length === 1 ? '' : 's'})`);
}

if (removed.length === 0) {
  console.log('Datastore already empty — nothing removed.');
} else {
  console.log('Reset complete. Removed:');
  for (const r of removed) console.log('  •', r);
  console.log('\nThe database will be recreated on the next boot.');
}
