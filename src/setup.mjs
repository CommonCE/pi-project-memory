import fs from 'node:fs';
import path from 'node:path';
import { assertSafe, discoverRoot, exclusive, initialize, listProjects, readProjectConfig, resolveProject, safeDirectory, slug } from './core.mjs';

// Parse command text without executing shell expansion. CLI argv is already tokenized.
export function parseSetupArgs(args) {
  const textInput = typeof args === 'string';
  const tokens = textInput ? [] : [...args];
  if (textInput) {
    const pattern = /\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"']+))/gy;
    let offset = 0;
    while (offset < args.trimEnd().length) {
      pattern.lastIndex = offset;
      const match = pattern.exec(args);
      if (!match) throw new Error('Invalid initialization arguments: check quotes');
      tokens.push(match[1] ?? match[2] ?? match[3]);
      offset = pattern.lastIndex;
    }
  }
  let profile;
  const names = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--profile' || token.startsWith('--profile=')) {
      if (profile !== undefined) throw new Error('Specify --profile only once');
      profile = token === '--profile' ? tokens[++i] : token.slice('--profile='.length);
      if (!['default', 'qchem'].includes(profile)) throw new Error('Usage: [name] [--profile default|qchem]');
    } else if (token.startsWith('--')) throw new Error(`Unknown initialization option: ${token}`);
    else names.push(token);
  }
  if (!textInput && names.length > 1) throw new Error('Usage: [name] [--profile default|qchem]; quote names containing spaces');
  return { name: names.length ? names.join(' ') : undefined, profile };
}

// Explicit user command only. Normal startup/learning never creates a .pi-root marker.
export function setupProject(cwd, config, name, profile) {
  if (!config.enabled) throw new Error('Project memory is globally disabled');
  if (profile !== undefined && !['default', 'qchem'].includes(profile)) throw new Error('profile must be default or qchem');
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\r\n]/.test(name))) throw new Error('Project name must be one nonempty line (max 200 characters)');
  if (name !== undefined) assertSafe(name);
  const real = fs.realpathSync(cwd);
  const root = discoverRoot(real) ?? real;
  const marker = path.join(root, '.pi-root');
  const localFile = path.join(root, '.pi/project-memory.json');
  const bound = listProjects(config).find(project => project.roots.includes(root));
  const piDir = path.join(root, '.pi');
  try {
    const stat = fs.lstatSync(piDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe project .pi directory');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Do not rewrite existing configuration or registry bindings.
  let localExists = false;
  try {
    const stat = fs.lstatSync(localFile);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe project memory configuration');
    const local = readProjectConfig(localFile);
    if (local.enabled === false) throw new Error('Project memory is disabled in project configuration');
    if (profile !== undefined && profile !== (local.profile ?? config.profile)) throw new Error('Project already has a different profile; update .pi/project-memory.json explicitly. Existing configuration was not overwritten.');
    localExists = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let packPath;
  if (!localExists && !bound) {
    const packs = path.join(root, 'pi-memory/packs');
    for (const directory of [path.join(root, 'pi-memory'), packs]) {
      try {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe project-local memory directory');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const inventory = fs.existsSync(packs) ? fs.readdirSync(packs, { withFileTypes: true }) : [];
    if (inventory.some(entry => entry.isSymbolicLink())) throw new Error('Legacy pack symlink found; inspect and use explicit adopt instead');
    const entries = inventory.filter(entry => entry.isDirectory());
    const requested = name === undefined ? undefined : slug(name);
    if (entries.length > 1 && !requested) throw new Error('Multiple legacy packs found; specify the existing pack name or use /memory adopt explicitly');
    if (entries.length && requested && !entries.some(entry => entry.name === requested)) throw new Error('Existing packs found but the requested name does not match; inspect them before initializing');
    packPath = path.join('pi-memory', 'packs', requested ?? entries[0]?.name ?? slug(path.basename(root)));
  }
  // A marker directory/broken symlink is not silently replaced.
  try {
    const stat = fs.lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Existing .pi-root must be a regular file; refusing to replace it');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    exclusive(marker, '');
  }
  if (packPath || (!localExists && profile !== undefined)) {
    safeDirectory(root, '.pi');
    const local = packPath ? { name: name?.trim() ?? path.basename(root), packPath: packPath.split(path.sep).join('/') } : {};
    if (profile !== undefined) local.profile = profile;
    exclusive(localFile, JSON.stringify(local, null, 2) + '\n');
  }
  const project = resolveProject(real, config);
  if (name !== undefined && (localExists || bound) && name.trim() !== project.name && slug(name) !== project.packSlug) throw new Error('Project is already configured with a different name; configuration was not overwritten');
  return initialize(project, config);
}
