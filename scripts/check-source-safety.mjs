import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const collect = (directory) => readdirSync(directory).flatMap((name) => {
  const path = join(directory, name);
  return statSync(path).isDirectory() ? collect(path) : (path.endsWith('.js') ? [path] : []);
});

const files = collect('src');
const rules = [
  [/process\.env\.FIRECRAWL_API_KEY/u, 'provider API key must never be read from service environment'],
  [/from ['"]node:child_process['"]/u, 'runtime source may not launch subprocesses'],
  [/\beval\s*\(/u, 'runtime source may not evaluate dynamic code'],
  [/redirect:\s*['"]follow['"]/u, 'provider redirects must remain disabled'],
  [/https?:\/\/api\.firecrawl\.dev[^'"/]*\/(?!v2\/(?:team\/(?:credit-usage|queue-status)|scrape|search|map))/u, 'only reviewed fixed provider routes are allowed'],
];
const failures = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const [pattern, message] of rules) if (pattern.test(source)) failures.push(file + ': ' + message);
}
if (failures.length) {
  process.stderr.write(failures.join('\n') + '\n');
  process.exit(1);
}
process.stdout.write('Source-safety check passed for ' + files.length + ' runtime files.\n');
