#!/usr/bin/env node
import { loadConfig } from '../src/core.mjs';
import { parseSetupArgs, setupProject } from '../src/setup.mjs';

try {
  const { name, profile } = parseSetupArgs(process.argv.slice(2));
  console.log(JSON.stringify(setupProject(process.cwd(), loadConfig(), name, profile), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
