#!/usr/bin/env node
'use strict';

/**
 * Parse every JavaScript file in the project and report anything that will not
 * load. Cheap safety net before a deploy: `npm run check`.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const skip = new Set(['node_modules', '.git', 'coverage']);
const files = [];

(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
})(root);

let bad = 0;
for (const file of files.sort()) {
  const label = path.relative(root, file);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`  ok    ${label}`);
  } catch (err) {
    bad += 1;
    console.log(`  FAIL  ${label}`);
    console.log(String(err.stderr || '').trim().split('\n').slice(0, 4).map((l) => `        ${l}`).join('\n'));
  }
}

console.log(`\n${files.length} file(s) checked, ${bad} with syntax errors.`);
process.exit(bad === 0 ? 0 : 1);
