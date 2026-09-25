// Run with: node tests/config.test.js
// Guards against committing a Supabase key that bypasses Row Level Security.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../js/config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude']);

// Role claim of a legacy JWT key, or null for non-JWT keys and placeholders.
function jwtRole(key) {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role ?? null;
  } catch {
    return null;
  }
}

function* projectFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* projectFiles(path);
    } else {
      yield path;
    }
  }
}

test('config uses an https Supabase URL', () => {
  assert.match(SUPABASE_URL, /^https:\/\//);
});

test('config key is not a service_role / secret key', () => {
  assert.ok(!SUPABASE_ANON_KEY.startsWith('sb_secret_'), 'secret key found in config.js');
  assert.notEqual(jwtRole(SUPABASE_ANON_KEY), 'service_role', 'service_role key found in config.js');
});

test('no file in the project contains a service_role or secret key', () => {
  const jwtPattern = /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g;
  for (const file of projectFiles(ROOT)) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/sb_secret_\w/.test(text), `secret key found in ${file}`);
    for (const [token] of text.matchAll(jwtPattern)) {
      assert.notEqual(jwtRole(token), 'service_role', `service_role key found in ${file}`);
    }
  }
});
