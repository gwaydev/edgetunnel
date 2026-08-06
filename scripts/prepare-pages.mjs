import { copyFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const outputDirectory = resolve('dist-pages');
const sourceWorker = resolve('dist/worker.js');
const pagesWorker = resolve(outputDirectory, '_worker.js');

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await copyFile(sourceWorker, pagesWorker);

console.log(`Cloudflare Pages bundle prepared: ${pagesWorker}`);
