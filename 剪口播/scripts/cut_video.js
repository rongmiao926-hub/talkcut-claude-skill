#!/usr/bin/env node
/**
 * 根据删除列表剪辑视频（filter_complex 精确剪辑）— 跨平台 Node.js 版本
 *
 * 用法: node cut_video.js <input.mp4> <delete_segments.json> [output.mp4]
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const INPUT = process.argv[2];
const DELETE_JSON = process.argv[3];
const OUTPUT = process.argv[4] || 'output_cut.mp4';

if (!INPUT || !DELETE_JSON) {
  console.error('❌ 用法: node cut_video.js <input.mp4> <delete_segments.json> [output.mp4]');
  process.exit(1);
}
if (!fs.existsSync(INPUT)) {
  console.error(`❌ 找不到输入文件: ${INPUT}`);
  process.exit(1);
}
if (!fs.existsSync(DELETE_JSON)) {
  console.error(`❌ 找不到删除列表: ${DELETE_JSON}`);
  process.exit(1);
}

// file: 前缀：macOS/Linux 文件名可能含冒号，Windows 不需要
function fileArg(p) {
  return process.platform === 'win32' ? p : `file:${p}`;
}

function readEnvConfig() {
  const envFile = path.join(__dirname, '..', '..', '.env');
  const config = {};
  if (!fs.existsSync(envFile)) return config;

  const content = fs.readFileSync(envFile, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).replace(/\s+#.*$/, '').trim();
    config[key] = value;
  }
  return config;
}

function parseMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function buildAdjustedDeleteSegments(deleteSegs, options) {
  const adjusted = [];
  for (const seg of deleteSegs) {
    const start = Math.max(0, seg.start + options.timelineOffsetSec - options.expandSec);
    const end = Math.min(options.duration, seg.end + options.timelineOffsetSec + options.expandSec);
    const rawDuration = Math.max(0, end - start);

    if (rawDuration >= options.minDeleteSec) {
      adjusted.push({ start, end });
    }
  }
  return adjusted;
}

function findAudioReferencePath() {
  const deleteDir = path.dirname(path.resolve(DELETE_JSON));
  const candidates = [
    path.join(deleteDir, 'audio.wav'),
    path.join(deleteDir, 'audio.mp3'),
    path.join(process.cwd(), 'audio.mp3'),
    path.join(process.cwd(), 'audio.wav'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function readTimelineMetadata() {
  const deleteDir = path.dirname(path.resolve(DELETE_JSON));
  const candidates = [
    path.join(deleteDir, 'audio_timeline.json'),
    path.join(process.cwd(), 'audio_timeline.json'),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (Number.isFinite(parsed.timelineOffsetSec)) {
        return parsed;
      }
    } catch (e) {
      // ignore malformed metadata and fall back to probing
    }
  }

  return null;
}

function probeMediaStartTime(mediaPath) {
  try {
    const output = execSync(
      `ffprobe -v error -show_entries format=start_time -of csv=p=0 "${fileArg(mediaPath)}"`,
      { encoding: 'utf8' }
    ).trim();
    return parseFloat(output) || 0;
  } catch (e) {
    return 0;
  }
}

function probeSourceAudioStartTime(inputPath) {
  try {
    const output = execSync(
      `ffprobe -v error -select_streams a:0 -show_entries stream=start_time -of csv=p=0 "${fileArg(inputPath)}"`,
      { encoding: 'utf8' }
    ).trim();
    return parseFloat(output) || 0;
  } catch (e) {
    return 0;
  }
}

function buildTempOutputPath(outputPath) {
  const resolved = path.resolve(outputPath);
  const dir = path.dirname(resolved);
  const ext = path.extname(resolved) || '.mp4';
  const base = path.basename(resolved, ext);
  return path.join(dir, `${base}.exporting.${process.pid}.${Date.now()}${ext}`);
}

function probeMediaInfo(mediaPath) {
  const raw = execSync(
    `ffprobe -v error -show_streams -show_format -print_format json "${fileArg(mediaPath)}"`,
    { encoding: 'utf8' }
  );
  return JSON.parse(raw);
}

function parseFraction(value) {
  if (!value || typeof value !== 'string') return 0;
  const [num, den] = value.split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

function validateOutputFile(outputPath, expectedDurationSec) {
  if (!fs.existsSync(outputPath)) {
    throw new Error(`导出文件不存在: ${outputPath}`);
  }

  const stat = fs.statSync(outputPath);
  if (stat.size < 1024) {
    throw new Error(`导出文件过小，疑似损坏: ${stat.size} bytes`);
  }

  const info = probeMediaInfo(outputPath);
  const video = info.streams.find(stream => stream.codec_type === 'video');
  const audio = info.streams.find(stream => stream.codec_type === 'audio');

  if (!video || !audio) {
    throw new Error('导出文件缺少视频流或音频流');
  }
  if (video.codec_name !== 'h264') {
    throw new Error(`导出视频编码不是 H.264，而是 ${video.codec_name}`);
  }
  if (video.pix_fmt !== 'yuv420p') {
    throw new Error(`导出视频像素格式不是 yuv420p，而是 ${video.pix_fmt}`);
  }
  if (audio.codec_name !== 'aac') {
    throw new Error(`导出音频编码不是 AAC，而是 ${audio.codec_name}`);
  }
  if (Number(audio.sample_rate) !== 48000) {
    throw new Error(`导出音频采样率不是 48k，而是 ${audio.sample_rate}`);
  }
  if (Number(audio.channels) !== 2) {
    throw new Error(`导出音频声道数不是 2，而是 ${audio.channels}`);
  }

  const formatStart = parseFloat(info.format.start_time) || 0;
  const videoStart = parseFloat(video.start_time) || 0;
  const audioStart = parseFloat(audio.start_time) || 0;
  if (Math.abs(formatStart) > 0.05 || Math.abs(videoStart) > 0.05 || Math.abs(audioStart) > 0.05) {
    throw new Error(`导出流起点异常: format=${formatStart}s video=${videoStart}s audio=${audioStart}s`);
  }

  const formatDuration = parseFloat(info.format.duration) || 0;
  if (formatDuration < 0.2) {
    throw new Error(`导出时长异常: ${formatDuration}s`);
  }

  if (Number.isFinite(expectedDurationSec) && expectedDurationSec > 0) {
    const durationDrift = Math.abs(formatDuration - expectedDurationSec);
    if (durationDrift > 1.0) {
      throw new Error(`导出时长偏差过大: 期望约 ${expectedDurationSec.toFixed(3)}s，实际 ${formatDuration.toFixed(3)}s`);
    }
  }

  const frameRate = parseFraction(video.avg_frame_rate) || parseFraction(video.r_frame_rate);
  if (frameRate > 0 && Math.abs(frameRate - 30) > 0.05) {
    throw new Error(`导出帧率不是 30fps，而是 ${frameRate.toFixed(3)}fps`);
  }

  execSync(`ffmpeg -v error -i "${fileArg(outputPath)}" -f null -`, { stdio: 'pipe' });

  return {
    duration: formatDuration,
    size: stat.size,
  };
}

function ensureVisibleInFinder(outputPath) {
  if (process.platform !== 'darwin') return;

  try {
    spawnSync('chflags', ['nohidden', path.resolve(outputPath)], { stdio: 'ignore' });
  } catch (e) {
    // ignore visibility fix failures; export itself is still valid
  }
}

function buildAudioFilter(seg, index, totalSegments, fadeSec) {
  const segDuration = Math.max(0, seg.end - seg.start);
  const maxFadeSec = Math.max(0, segDuration / 2 - 0.001);
  const effectiveFadeSec = Math.min(fadeSec, maxFadeSec);

  let filter = `[0:a]atrim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},asetpts=PTS-STARTPTS`;

  if (effectiveFadeSec > 0 && totalSegments > 1) {
    if (index > 0) {
      filter += `,afade=t=in:st=0:d=${effectiveFadeSec.toFixed(3)}`;
    }
    if (index < totalSegments - 1) {
      const fadeOutStart = Math.max(0, segDuration - effectiveFadeSec);
      filter += `,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${effectiveFadeSec.toFixed(3)}`;
    }
  }

  return `${filter}[a${index}]`;
}

function detectSpeechBoundsInKeepSegment(inputPath, seg, options) {
  const segDuration = seg.end - seg.start;
  if (segDuration <= options.minKeepSec) {
    return seg;
  }

  const args = [
    '-hide_banner',
    '-ss',
    seg.start.toFixed(3),
    '-to',
    seg.end.toFixed(3),
    '-i',
    fileArg(inputPath),
    '-map',
    '0:a:0',
    '-af',
    `silencedetect=noise=${options.silenceNoiseDb}:d=${options.detectSilenceSec}`,
    '-f',
    'null',
    '-',
  ];

  const result = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (result.error) {
    return seg;
  }

  const log = `${result.stderr || ''}\n${result.stdout || ''}`;
  const lines = log.split('\n');

  let pendingSilenceStart = null;
  let leadingSilenceEnd = null;
  let trailingSilenceStart = null;

  for (const line of lines) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch) {
      pendingSilenceStart = parseFloat(startMatch[1]);
      continue;
    }

    const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
    if (!endMatch) continue;

    const silenceEnd = parseFloat(endMatch[1]);
    const silenceDuration = parseFloat(endMatch[2]);
    const silenceStart = pendingSilenceStart ?? Math.max(0, silenceEnd - silenceDuration);

    if (silenceStart <= options.edgeSlackSec && silenceDuration >= options.trimSilenceSec) {
      leadingSilenceEnd = silenceEnd;
    }

    if (segDuration - silenceEnd <= options.edgeSlackSec && silenceDuration >= options.trimSilenceSec) {
      trailingSilenceStart = silenceStart;
    }

    pendingSilenceStart = null;
  }

  let speechStart = seg.start;
  let speechEnd = seg.end;

  if (leadingSilenceEnd !== null && segDuration - leadingSilenceEnd >= options.minKeepSec) {
    speechStart = seg.start + leadingSilenceEnd;
  }

  if (trailingSilenceStart !== null && trailingSilenceStart >= options.minKeepSec) {
    speechEnd = seg.start + trailingSilenceStart;
  }

  if (speechEnd - speechStart < options.minKeepSec) {
    return seg;
  }

  const refined = {
    start: Math.max(0, speechStart - options.keepPaddingSec),
    end: Math.min(options.duration, speechEnd + options.keepPaddingSec),
  };

  if (refined.start > seg.start + 0.05 || refined.end < seg.end - 0.05) {
    console.log(
      `🎯 保留片段静音收紧: ${seg.start.toFixed(2)}-${seg.end.toFixed(2)}s -> ${refined.start.toFixed(2)}-${refined.end.toFixed(2)}s`
    );
  }

  return refined;
}

function refineKeepSegments(inputPath, keepSegs, options) {
  const refined = [];

  for (const seg of keepSegs) {
    const next = detectSpeechBoundsInKeepSegment(inputPath, seg, options);
    if (next.end - next.start >= options.minKeepSec) {
      refined.push(next);
    }
  }

  if (refined.length === 0) {
    return keepSegs;
  }

  const merged = [];
  for (const seg of refined) {
    if (merged.length === 0 || seg.start > merged[merged.length - 1].end) {
      merged.push({ ...seg });
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, seg.end);
    }
  }

  return merged;
}

// 获取视频时长
const duration = parseFloat(
  execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${fileArg(INPUT)}"`, { encoding: 'utf8' }).trim()
);
console.log(`📹 视频时长: ${duration}s`);

// 配置参数
const envConfig = readEnvConfig();
const CUT_EXPAND_MS = parseMs(envConfig.CUT_EXPAND_MS, 0);
const CUT_KEEP_PADDING_MS = parseMs(envConfig.CUT_KEEP_PADDING_MS, 0);
const CUT_MIN_DELETE_MS = parseMs(envConfig.CUT_MIN_DELETE_MS, 120);
const CROSSFADE_MS = parseMs(envConfig.CROSSFADE_MS, 30);
const expandSec = CUT_EXPAND_MS / 1000;
const keepPaddingSec = CUT_KEEP_PADDING_MS / 1000;
const minDeleteSec = CUT_MIN_DELETE_MS / 1000;
const crossfadeSec = CROSSFADE_MS / 1000;

console.log(`⚙️ 优化参数: 边界保留=${CUT_KEEP_PADDING_MS}ms, 最小删除=${CUT_MIN_DELETE_MS}ms, 额外扩展=${CUT_EXPAND_MS}ms, 音频接缝淡化=${CROSSFADE_MS}ms`);

// 读取并处理删除片段
const deleteSegs = JSON.parse(fs.readFileSync(DELETE_JSON, 'utf8'));
deleteSegs.sort((a, b) => a.start - b.start);

const audioReference = findAudioReferencePath();
const timelineMetadata = readTimelineMetadata();
const reviewAudioStartSec = audioReference ? probeMediaStartTime(audioReference) : 0;
const sourceAudioStartSec = probeSourceAudioStartTime(INPUT);
const timelineOffsetSec = timelineMetadata
  ? Number(timelineMetadata.timelineOffsetSec) || 0
  : sourceAudioStartSec - reviewAudioStartSec;
if (timelineMetadata) {
  console.log(`🔧 已读取时间轴元数据，导出映射补偿=${timelineOffsetSec.toFixed(3)}s`);
} else if (audioReference) {
  console.log(`🔧 审核音频起点=${reviewAudioStartSec.toFixed(3)}s，源视频音频起点=${sourceAudioStartSec.toFixed(3)}s，导出映射补偿=${timelineOffsetSec.toFixed(3)}s`);
}

// 映射删除范围
const adjustedSegs = buildAdjustedDeleteSegments(deleteSegs, {
  timelineOffsetSec,
  duration,
  expandSec,
  minDeleteSec,
});

if (adjustedSegs.length === 0 && deleteSegs.length > 0) {
  console.log('⚠️ 当前删除片段都很短，按保留策略收缩后没有可执行的删除范围');
}

// 合并重叠的删除段
const mergedSegs = [];
for (const seg of adjustedSegs) {
  if (mergedSegs.length === 0 || seg.start > mergedSegs[mergedSegs.length - 1].end) {
    mergedSegs.push({ ...seg });
  } else {
    mergedSegs[mergedSegs.length - 1].end = Math.max(mergedSegs[mergedSegs.length - 1].end, seg.end);
  }
}

// 计算保留片段
const keepSegs = [];
let cursor = 0;
for (const del of mergedSegs) {
  if (del.start > cursor) {
    keepSegs.push({ start: cursor, end: del.start });
  }
  cursor = del.end;
}
if (cursor < duration) {
  keepSegs.push({ start: cursor, end: duration });
}

const refinedKeepSegs = refineKeepSegments(INPUT, keepSegs, {
  duration,
  keepPaddingSec,
  detectSilenceSec: 0.15,
  trimSilenceSec: 0.25,
  edgeSlackSec: 0.08,
  silenceNoiseDb: '-35dB',
  minKeepSec: 0.12,
});

console.log(`保留片段数: ${refinedKeepSegs.length}`);
console.log(`删除片段数: ${mergedSegs.length}`);

let deletedTime = 0;
for (const seg of mergedSegs) deletedTime += seg.end - seg.start;
console.log(`删除总时长: ${deletedTime.toFixed(2)}s`);

// 生成 filter_complex
const filters = [];
let vconcat = '';
const aLabels = [];

for (let i = 0; i < refinedKeepSegs.length; i++) {
  const seg = refinedKeepSegs[i];
  filters.push(`[0:v]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
  filters.push(buildAudioFilter(seg, i, refinedKeepSegs.length, crossfadeSec));
  vconcat += `[v${i}]`;
  aLabels.push(`a${i}`);
}

filters.push(`${vconcat}concat=n=${refinedKeepSegs.length}:v=1:a=0[outv]`);

if (refinedKeepSegs.length === 1) {
  filters.push('[a0]anull[outa]');
} else {
  filters.push(`${aLabels.map(label => `[${label}]`).join('')}concat=n=${refinedKeepSegs.length}:v=0:a=1[outa]`);
}

filters.push('[outv]fps=30,setsar=1,format=yuv420p[vfinal]');
filters.push('[outa]aresample=48000:async=1:first_pts=0,pan=stereo|c0=c0|c1=c0[afinal]');

const filterCmd = filters.join(';');
const expectedDuration = refinedKeepSegs.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
const tempOutput = buildTempOutputPath(OUTPUT);

fs.mkdirSync(path.dirname(path.resolve(OUTPUT)), { recursive: true });

console.log('\n✂️ 执行 FFmpeg 精确剪辑...');

try {
  execSync(
    `ffmpeg -y -i "${fileArg(INPUT)}" -filter_complex "${filterCmd}" -map "[vfinal]" -map "[afinal]" -map_metadata -1 -map_chapters -1 -c:v libx264 -preset fast -crf 18 -profile:v high -level:v 4.1 -pix_fmt yuv420p -tag:v avc1 -movflags +faststart -brand mp42 -video_track_timescale 30000 -c:a aac -profile:a aac_low -ar 48000 -ac 2 -b:a 192k "${fileArg(tempOutput)}"`,
    { stdio: 'inherit' }
  );

  const validated = validateOutputFile(tempOutput, expectedDuration);
  fs.renameSync(tempOutput, path.resolve(OUTPUT));
  ensureVisibleInFinder(OUTPUT);
  console.log(`✅ 已保存: ${OUTPUT}`);
  console.log(`📹 新时长: ${validated.duration}s`);
  console.log(`📦 文件大小: ${validated.size} bytes`);
} catch (e) {
  if (fs.existsSync(tempOutput)) {
    fs.rmSync(tempOutput, { force: true });
  }
  console.error('❌ 剪辑失败');
  if (e instanceof Error && e.message) {
    console.error(e.message);
  }
  process.exit(1);
}
