#!/usr/bin/env node
/**
 * 规范化 auto_selected.json，并补上“夹在两个待删片段之间的短停顿”。
 *
 * 用法:
 *   node refine_auto_selected.js <subtitles_words.json> <auto_selected.json> [output.json]
 */

const fs = require('fs');
const path = require('path');
const { normalizeSelectedIndices } = require('./auto_selected_utils');

const wordsFile = process.argv[2];
const autoSelectedFile = process.argv[3];
const outputFile = process.argv[4] || autoSelectedFile;

if (!wordsFile || !autoSelectedFile) {
  console.error('❌ 用法: node refine_auto_selected.js <subtitles_words.json> <auto_selected.json> [output.json]');
  process.exit(1);
}

if (!fs.existsSync(wordsFile)) {
  console.error(`❌ 找不到字幕文件: ${wordsFile}`);
  process.exit(1);
}

if (!fs.existsSync(autoSelectedFile)) {
  console.error(`❌ 找不到 auto_selected 文件: ${autoSelectedFile}`);
  process.exit(1);
}

const words = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
const selected = JSON.parse(fs.readFileSync(autoSelectedFile, 'utf8'));
const normalized = normalizeSelectedIndices(words, selected);

fs.writeFileSync(outputFile, `${JSON.stringify(normalized.indices, null, 2)}\n`);

console.log(`✅ 已规范化 auto_selected: ${path.resolve(outputFile)}`);
console.log(`📌 总索引数: ${normalized.indices.length}`);
if (normalized.addedBridgeGaps > 0) {
  console.log(`🔗 新增短停顿桥接: ${normalized.addedBridgeGaps} 个`);
}
