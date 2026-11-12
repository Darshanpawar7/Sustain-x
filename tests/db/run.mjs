#!/usr/bin/env node
// Database tests for supabase/flowstate_setup.sql: applies the setup twice (to
// prove it is safe to re-run) on a fresh database, then runs
// tests/db/setup_assertions.sql.
//
// Uses DATABASE_URL when it is set (for example in CI): a scratch database
// named flowstate_setup_test is created there. Otherwise it creates a
// temporary PostgreSQL cluster with initdb/pg_ctl. Those tools must be on PATH,
// or set PG_BIN to the folder that contains them.
//
// To check a live Supabase project without leaving anything behind, run the
// setup and the assertions inside one transaction that is rolled back (see
// docs/TESTING.md).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const setupFile = join(here, '..', '..', 'supabase', 'flowstate_setup.sql');
const TEMP_PORT = '54329';
const SCRATCH_DB = 'flowstate_setup_test';

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
  for (const sql of [`drop database if exists ${SCRATCH_DB}`, `create database ${SCRATCH_DB}`]) {
    runOrThrow('psql', [connection, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  }
  const url = new URL(connection);
  url.pathname = `/${SCRATCH_DB}`;
  const scratch = url.toString();

  applySqlFile(scratch, join(here, 'supabase_stub.sql'));
  for (const pass of [1, 2]) {
    console.log(`\n== Applying flowstate_setup.sql (pass ${pass}) ==`);
    applySqlFile(scratch, setupFile);
  }
  console.log('\n== Running setup assertions ==');
  applySqlFile(scratch, join(here, 'setup_assertions.sql'));
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
