// Driver for the markdown-render-speed-02 harness.
//
// The harness starts this program as `node /bot/main.ts` with the case set
// mounted read-only at /input and a writable /output. Outside that sandbox
// the MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR environment variables name the
// two directories instead. We read every case ({id, markdown}) from
// cases.json, render each one on its own with parse() from ./parse.js, and
// write the resulting HTML strings, in the cases' order, as a JSON array to
// html.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Case {
  id: string;
  markdown: string;
}

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as Case[];

const rendered: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  rendered[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
