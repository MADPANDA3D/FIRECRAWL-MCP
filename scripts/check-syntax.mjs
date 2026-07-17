import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const collect = (directory) => readdirSync(directory).flatMap((name) => {
  const path = join(directory, name);
  return statSync(path).isDirectory() ? collect(path) : (path.endsWith('.js') || path.endsWith('.mjs') ? [path] : []);
});

const files = [...collect('src'), ...collect('scripts'), ...(statSync('test').isDirectory() ? collect('test') : [])];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
process.stdout.write('Syntax check passed for ' + files.length + ' JavaScript files.\n');
