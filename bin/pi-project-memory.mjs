#!/usr/bin/env node
import { run } from '../src/cli.mjs';
try {
  console.log(JSON.stringify(await run(process.argv.slice(2)), null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error.code ?? 'operation-failed', message: error.message }));
  process.exitCode = 1;
}
