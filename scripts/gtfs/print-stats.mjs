#!/usr/bin/env node
// Reads .gtfs_stats.json (in cwd) and prints the import breakdown.
// Exit 0 → feed unchanged, nothing to import.
// Exit 1 → there are changes (shell should proceed to confirmation).

import { readFileSync } from 'fs';
import chalk from 'chalk';

const s = JSON.parse(readFileSync('scripts/gtfs/artifacts/.gtfs_stats.json', 'utf8'));

if (s.noChange) {
  // nothing to print — caller handles the "unchanged" message
  process.exit(0);
}

console.log(`  Mode : ${s.mode}${s.mode === 'diff' ? `  (${s.oldVersion} → ${s.newVersion})` : ''}`);
console.log('');

let totalU = 0, totalD = 0;
for (const t of s.tables) {
  const name = t.table.padEnd(16);
  if (t.upsertRows === 0 && t.deleteRows === 0) {
    console.log('  ' + chalk.dim(name + '(unchanged)'));
  } else {
    const parts = [];
    if (t.upsertRows > 0) parts.push(`+${t.upsertRows.toLocaleString()} upserts (${Math.ceil(t.upsertRows / 500)} stmts)`);
    if (t.deleteRows > 0) parts.push(`-${t.deleteRows.toLocaleString()} deletes (${Math.ceil(t.deleteRows / 500)} stmts)`);
    console.log('  ' + chalk.yellow(name) + parts.join(', '));
    totalU += t.upsertRows;
    totalD += t.deleteRows;
  }
}

const totalStmts = s.totalUpsertStatements + s.totalDeleteStatements;
console.log('');
console.log(`  Total : ${totalU.toLocaleString()} upserts, ${totalD.toLocaleString()} deletes → ${totalStmts.toLocaleString()} SQL statements`);

process.exit(1); // signal to shell: there ARE changes to import
