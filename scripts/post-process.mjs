import {
  existsSync,
  globSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { resolve } from 'node:path';
import {
  assertShipped,
  alpha,
  buildHtml,
  shipHtml
} from '@shieldfont/core';

const destinationArgument = process.argv[2];

if (!destinationArgument) {
  throw new Error(
    'Missing generated-site directory.\n' +
      'Usage: node scripts/post-process.mjs <destination>'
  );
}

const destination = resolve(destinationArgument);

if (!existsSync(destination)) {
  throw new Error(`Generated-site directory does not exist: ${destination}`);
}

const htmlFiles = globSync(`${destination}/**/*.html`, {
  nodir: true
});

if (htmlFiles.length === 0) {
  console.warn(`No HTML files found in ${destination}`);
}

let processedFiles = 0;

for (const file of htmlFiles) {
  const source = readFileSync(file, 'utf8');

  const built = buildHtml(source, alpha);
  const shipped = shipHtml(built);

  assertShipped(shipped);

  if (shipped !== source) {
    writeFileSync(file, shipped, 'utf8');
    console.log(`ShieldFont changed: ${file}`);
  } else {
    console.log(`No ShieldFont markers: ${file}`);
  }

  processedFiles += 1;
}

console.log(`ShieldFont processed ${processedFiles} HTML file(s).`);