#!/usr/bin/env node
// Applies every Supabase migration (twice, to prove they are safe to re-run)
// and then runs tests/db/assertions.sql.
//
// Uses DATABASE_URL when it is set (for example in CI). Otherwise it creates a
// temporary PostgreSQL cluster with initdb/pg_ctl. Those tools must be on PATH,
// or set PG_BIN to the folder that contains them.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'supabase', 'migrations');
const TEMP_PORT = '54329';

function run(command, args, options = {}) {
  const executable = process.env.PG_BIN ? join(process.env.PG_BIN, command) : command;
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 120000, ...options });
  if (result.error) {
    throw new Error(`Could not run ${command}: ${result.error.message}`);
  }
  return result;
}

function runOrThrow(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(`${command} failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
  return result;
}

function applySqlFile(connection, file) {
  const result = run('psql', [connection, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', file]);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`psql failed on ${file}`);
  }
}

function runSuite(connection) {
  const migrations = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => join(migrationsDir, name));

  applySqlFile(connection, join(here, 'supabase_stub.sql'));
  for (const pass of [1, 2]) {
    console.log(`\n== Applying ${migrations.length} migrations (pass ${pass}) ==`);
    migrations.forEach((file) => applySqlFile(connection, file));
  }
  console.log('\n== Running assertions ==');
  applySqlFile(connection, join(here, 'assertions.sql'));
}

function withTemporaryCluster(callback) {
  const dataDir = mkdtempSync(join(tmpdir(), 'flowstate-pg-'));
  runOrThrow('initdb', ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8']);
  // The server outlives pg_ctl; sharing pipes with it would block spawnSync forever.
  runOrThrow('pg_ctl', [
    '-D', dataDir,
    '-o', `-p ${TEMP_PORT} -c listen_addresses=localhost`,
    '-l', join(dataDir, 'server.log'),
    '-w', 'start'
  ], { stdio: 'ignore' });
  try {
    callback(`postgresql://postgres@localhost:${TEMP_PORT}/postgres`);
  } finally {
    run('pg_ctl', ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

try {
  if (process.env.DATABASE_URL) {
    runSuite(process.env.DATABASE_URL);
  } else {
    withTemporaryCluster(runSuite);
  }
  console.log('\nDatabase tests passed.');
} catch (error) {
  console.error(`\nDatabase tests failed: ${error.message}`);
  process.exit(1);
}
