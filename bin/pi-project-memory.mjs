#!/usr/bin/env node
import { adoptPack, assertMemoryEnabled, effectiveConfig, initialize, listProjects, loadConfig, memoryStats, resolveProject, saveNote, search } from '../src/core.mjs';
import { listCandidates, reviewCandidate } from '../src/learning.mjs';
import { parseSetupArgs, setupProject } from '../src/setup.mjs';
import { runV2 } from '../src/v2-cli.mjs';

async function main() {
  const [command = 'status', ...args] = process.argv.slice(2);
  if (command === 'v2') {
    console.log(JSON.stringify(await runV2(args), null, 2));
    return;
  }
  const globalConfig = loadConfig();
  const project = resolveProject(process.cwd(), globalConfig);
  const config = effectiveConfig(globalConfig, project);
  let result;
  switch (command) {
    case 'status': result = { ...project, profile: config.profile, capacity: { maxItems: config.maxItems, contextChars: config.contextChars, learningMaxCandidates: config.learningMaxCandidates, learningToolChars: config.learningToolChars, learningOutputTokens: config.learningOutputTokens }, stats: { ...memoryStats(project, config), pending: project.enabled ? listCandidates(project).length : 0 } }; break;
    case 'stats': result = { ...memoryStats(project, config), pending: project.enabled ? listCandidates(project).length : 0 }; break;
    case 'projects': assertMemoryEnabled(project); result = listProjects(config); break;
    case 'init': result = initialize(project, config); break;
    case 'setup': {
      const { name, profile } = parseSetupArgs(args);
      result = setupProject(process.cwd(), config, name, profile); break;
    }
    case 'review': {
      const [action = 'list', id, ...rest] = args;
      if (rest.length || (['list', 'all'].includes(action) ? id !== undefined : id === undefined)) throw new Error('Usage: pi-project-memory review [list|all|show <id>|approve <id>|reject <id>]');
      result = ['list', 'all'].includes(action) ? listCandidates(project, { all: action === 'all' }) : reviewCandidate(project, id, action);
      break;
    }
    case 'adopt':
      if (args.length !== 1) throw new Error('Usage: pi-project-memory adopt <existing-pack-path>');
      result = adoptPack(project, args[0], config); break;
    case 'search': {
      const all = args[0] === '--all';
      result = search(project, (all ? args.slice(1) : args).join(' '), config, config.maxItems, undefined, { includeInactive: all, includeHandoffs: all }); break;
    }
    case 'save': {
      if (args.length) throw new Error('Usage: echo JSON | pi-project-memory save');
      const chunks = []; let bytes = 0;
      for await (const chunk of process.stdin) {
        bytes += chunk.length;
        if (bytes > 200000) throw new Error('Save input exceeds 200000 bytes');
        chunks.push(chunk);
      }
      result = saveNote(project, JSON.parse(Buffer.concat(chunks).toString('utf8'))); break;
    }
    default: throw new Error('Commands: status | stats | projects | init | setup [name] | adopt <path> | search <query> | save (JSON stdin) | review [list|all|show <id>|approve <id>|reject <id>]');
  }
  console.log(JSON.stringify(result, null, 2));
}

try {
  await main();
} catch (error) {
  const v2 = process.argv[2] === 'v2';
  console.error(error.code && error.name === 'MemoryError' ? `${error.code}: ${error.message}` : v2 ? 'v2-operation-failed: inspect project configuration and store permissions' : error.message);
  process.exitCode = 1;
}
