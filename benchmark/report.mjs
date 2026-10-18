#!/usr/bin/env node
// Prints the header and tables of a results file written by run.mjs, for example after an interrupted run.
import { readFileSync } from 'node:fs';
import { formatReport } from './lib.mjs';

const [file] = process.argv.slice(2);
if (!file) {
    console.error('用法：node benchmark/report.mjs <结果 JSON>');
    process.exit(2);
}
console.log(formatReport(JSON.parse(readFileSync(file, 'utf8'))));
