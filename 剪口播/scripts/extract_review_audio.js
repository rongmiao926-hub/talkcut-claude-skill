#!/usr/bin/env node
/**
 * 从视频提取“和视频时间轴对齐”的审核音频。
 *
 * 用法:
 *   node extract_review_audio.js <input.mp4> [output.wav] [metadata.json]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const INPUT = process.argv[2];
const OUTPUT = process.argv[3] || 'audio.wav';
const METADATA = process.argv[4] || 'audio_timeline.json';

if (!INPUT) {
  console.error('❌ 用法: node extract_review_audio.js <input.mp4> [output.wav] [metadata.json]');
  process.exit(1);
}

if (!fs.existsSync(INPUT)) {
  console.error(`❌ 找不到输入视频: ${INPUT}`);
  process.exit(1);
}

function fileArg(p) {
  return process.platform === 'win32' ? p : `file:${p}`;
}

function probeFloat(cmd) {
  const output = execSync(cmd, { encoding: 'utf8' }).trim();
  if (!output || output === 'N/A') return 0;
  return parseFloat(output) || 0;
}

const sourceAudioStartSec = probeFloat(
  `ffprobe -v error -select_streams a:0 -show_entries stream=start_time -of csv=p=0 "${fileArg(INPUT)}"`
);

console.log(`🎯 源视频主音频起点: ${sourceAudioStartSec.toFixed(6)}s`);

let command;
if (sourceAudioStartSec > 0) {
  command = [
    `ffmpeg -y`,
    `-f lavfi -i "anullsrc=r=44100:cl=mono"`,
    `-i "${fileArg(INPUT)}"`,
    `-filter_complex "[0:a]atrim=duration=${sourceAudioStartSec.toFixed(6)}[sil];[1:a:0]aresample=44100,aformat=channel_layouts=mono,asetpts=PTS-STARTPTS[a];[sil][a]concat=n=2:v=0:a=1[out]"`,
    `-map "[out]" -c:a pcm_s16le "${fileArg(OUTPUT)}"`,
  ].join(' ');
} else {
  command = [
    `ffmpeg -y -i "${fileArg(INPUT)}"`,
    `-map 0:a:0 -ar 44100 -ac 1 -c:a pcm_s16le "${fileArg(OUTPUT)}"`,
  ].join(' ');
}

execSync(command, { stdio: 'inherit' });

const metadata = {
  alignedToVideoTimeline: true,
  timelineOffsetSec: 0,
  sourceAudioStartSec,
  sourceVideo: path.resolve(INPUT),
  reviewAudio: path.resolve(OUTPUT),
};

fs.writeFileSync(METADATA, `${JSON.stringify(metadata, null, 2)}\n`);

console.log(`✅ 已生成审核音频: ${path.resolve(OUTPUT)}`);
console.log(`📝 已写入时间轴元数据: ${path.resolve(METADATA)}`);
