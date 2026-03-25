#!/usr/bin/env node
/**
 * 审核服务器
 *
 * 功能：
 * 1. 提供静态文件服务（review.html, audio.*）
 * 2. POST /api/cut - 接收删除列表，执行剪辑
 * 3. GET/POST /api/show-notes - 读取或保存 AI 生成的视频介绍草稿
 *
 * 用法: node review_server.js [port] [video_file] [output_root]
 * 默认: port=8899, video_file=自动检测目录下的 .mp4
 * output_root: 可选；剪辑后的 MP4 再额外复制一份到该目录（方便直接访问）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = process.argv[2] || 8899;
let VIDEO_FILE = process.argv[3] || findVideoFile();
const OUTPUT_ROOT = process.argv[4] || '';

// file: 前缀：macOS/Linux 文件名可能含冒号，Windows 不需要
function fileArg(p) {
  return process.platform === 'win32' ? p : `file:${p}`;
}

function getEnvFilePath() {
  return path.join(__dirname, '..', '..', '.env');
}

function findVideoFile() {
  const files = fs.readdirSync('.').filter(f => ['.mp4', '.mov', '.m4v'].includes(path.extname(f).toLowerCase()));
  return files[0] || 'source.mp4';
}

function readEnvConfig() {
  const envFile = getEnvFilePath();
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

function readTimelineMetadata() {
  const candidates = [
    path.resolve('audio_timeline.json'),
    path.join(__dirname, '..', 'audio_timeline.json'),
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

function parseMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getRuntimeInfo(videoFile) {
  const envConfig = readEnvConfig();
  const configuredOutputDir = String(envConfig.DEFAULT_OUTPUT_DIR || '').trim();
  const resolvedVideoFile = path.resolve(videoFile);

  if (configuredOutputDir) {
    return {
      cutOutputDir: path.resolve(configuredOutputDir),
      videoFile: resolvedVideoFile,
      envFile: getEnvFilePath(),
      usesConfiguredOutputDir: true,
      outputSourceText: `已读取 DEFAULT_OUTPUT_DIR：${path.resolve(configuredOutputDir)}`,
    };
  }

  const sourceDir = path.dirname(resolvedVideoFile);
  const fallbackOutputDir = path.join(sourceDir, 'output');
  return {
    cutOutputDir: fallbackOutputDir,
    videoFile: resolvedVideoFile,
    envFile: getEnvFilePath(),
    usesConfiguredOutputDir: false,
    outputSourceText: '当前 DEFAULT_OUTPUT_DIR 为空，已回退到源视频同级的 output/ 目录。',
  };
}

function buildAdjustedDeleteSegments(deleteList, options) {
  const adjusted = [];
  for (const seg of deleteList) {
    const rawStart = Math.max(0, seg.start + options.timelineOffsetSec);
    const rawEnd = Math.min(options.duration, seg.end + options.timelineOffsetSec);
    const rawDuration = Math.max(0, rawEnd - rawStart);
    if (rawDuration <= 0) continue;

    const maxKeepSec = Math.max(0, (rawDuration - options.minDeleteSec) / 2);
    const effectiveKeepSec = Math.min(options.keepPaddingSec, maxKeepSec);
    const start = Math.max(0, rawStart + effectiveKeepSec - options.expandSec);
    const end = Math.min(options.duration, rawEnd - effectiveKeepSec + options.expandSec);

    if (end > start) {
      adjusted.push({ start, end });
    }
  }
  return adjusted;
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

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/api/runtime-info') {
    const runtimeInfo = getRuntimeInfo(VIDEO_FILE);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      ...runtimeInfo,
    }));
    return;
  }

  // API: 读取 AI 视频介绍草稿
  if (req.method === 'GET' && req.url === '/api/show-notes') {
    try {
      const outputFile = '视频介绍草稿.md';
      if (!fs.existsSync(outputFile)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: '当前目录还没有 AI 生成的视频介绍草稿，请先在 Claude 主流程里生成。',
        }));
        return;
      }

      const text = fs.readFileSync(outputFile, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        output: outputFile,
        text,
      }));
    } catch (err) {
      console.error('❌ 读取视频介绍草稿失败:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // API: 保存 AI 视频介绍草稿
  if (req.method === 'POST' && req.url === '/api/show-notes') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const text = String(payload.text || '').trim();
        const outputFile = '视频介绍草稿.md';

        if (!text) {
          throw new Error('视频介绍草稿内容为空，无法保存');
        }

        fs.writeFileSync(outputFile, text, 'utf8');
        console.log(`📝 已保存视频介绍草稿: ${outputFile}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          output: outputFile,
        }));
      } catch (err) {
        console.error('❌ 视频介绍草稿保存失败:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API: 执行剪辑
  if (req.method === 'POST' && req.url === '/api/cut') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const deleteList = JSON.parse(body);

        // 保存删除列表到当前目录
        fs.writeFileSync('delete_segments.json', JSON.stringify(deleteList, null, 2));
        console.log(`📝 保存 ${deleteList.length} 个删除片段`);

        // 成片 MP4 直接输出到默认输出目录根下
        const baseName = path.parse(VIDEO_FILE).name;
        const runtimeInfo = getRuntimeInfo(VIDEO_FILE);
        fs.mkdirSync(runtimeInfo.cutOutputDir, { recursive: true });
        const outputFile = path.join(runtimeInfo.cutOutputDir, `${baseName}_cut.mp4`);
        console.log(`📦 成片输出目录: ${runtimeInfo.cutOutputDir}`);

        // 执行剪辑：优先用 cut_video.js，其次 cut_video.sh，最后内置逻辑
        const jsScriptPath = path.join(__dirname, 'cut_video.js');
        const shScriptPath = path.join(__dirname, 'cut_video.sh');

        if (fs.existsSync(jsScriptPath)) {
          console.log('🎬 调用 cut_video.js...');
          execSync(`node "${jsScriptPath}" "${VIDEO_FILE}" delete_segments.json "${outputFile}"`, {
            stdio: 'inherit'
          });
        } else if (fs.existsSync(shScriptPath) && process.platform !== 'win32') {
          console.log('🎬 调用 cut_video.sh...');
          execSync(`bash "${shScriptPath}" "${VIDEO_FILE}" delete_segments.json "${outputFile}"`, {
            stdio: 'inherit'
          });
        } else {
          console.log('🎬 执行剪辑...');
          executeFFmpegCut(VIDEO_FILE, deleteList, outputFile);
        }

        // 获取剪辑前后的时长信息
        const originalDuration = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${fileArg(VIDEO_FILE)}"`).toString().trim());
        const newDuration = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${fileArg(outputFile)}"`).toString().trim());
        const deletedDuration = originalDuration - newDuration;
        const savedPercent = ((deletedDuration / originalDuration) * 100).toFixed(1);

        // 如显式传入 OUTPUT_ROOT，再额外复制一份到该目录
        let finalOutputPath = path.resolve(outputFile);
        let finalOutputDir = runtimeInfo.cutOutputDir;
        if (OUTPUT_ROOT) {
          const resolvedOutputRoot = path.resolve(OUTPUT_ROOT);
          fs.mkdirSync(resolvedOutputRoot, { recursive: true });

          if (resolvedOutputRoot !== path.resolve(runtimeInfo.cutOutputDir)) {
            const dest = path.join(resolvedOutputRoot, path.basename(outputFile));
            fs.copyFileSync(outputFile, dest);
            finalOutputPath = dest;
            finalOutputDir = resolvedOutputRoot;
            console.log(`📂 已额外复制到输出目录: ${dest}`);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          output: finalOutputPath,
          outputDir: finalOutputDir,
          originalDuration: originalDuration.toFixed(2),
          newDuration: newDuration.toFixed(2),
          deletedDuration: deletedDuration.toFixed(2),
          savedPercent: savedPercent,
          message: `剪辑完成: ${finalOutputPath}`
        }));

      } catch (err) {
        console.error('❌ 剪辑失败:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 静态文件服务（从当前目录读取）
  let filePath = req.url === '/' ? '/review.html' : req.url;
  filePath = '.' + filePath;

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  // 检查文件是否存在
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const stat = fs.statSync(filePath);

  // 支持 Range 请求（音频/视频拖动）
  if (req.headers.range && (ext === '.mp3' || ext === '.m4a' || ext === '.wav' || ext === '.mp4')) {
    const range = req.headers.range.replace('bytes=', '').split('-');
    const start = parseInt(range[0], 10);
    const end = range[1] ? parseInt(range[1], 10) : stat.size - 1;

    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });

    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  // 普通请求
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes'
  });
  fs.createReadStream(filePath).pipe(res);
});

// 检测可用的硬件编码器
function detectEncoder() {
  const platform = process.platform;
  const encoders = [];

  // 根据平台确定候选编码器
  if (platform === 'darwin') {
    encoders.push({ name: 'h264_videotoolbox', args: '-q:v 60', label: 'VideoToolbox (macOS)' });
  } else if (platform === 'win32') {
    encoders.push({ name: 'h264_nvenc', args: '-preset p4 -cq 20', label: 'NVENC (NVIDIA)' });
    encoders.push({ name: 'h264_qsv', args: '-global_quality 20', label: 'QSV (Intel)' });
    encoders.push({ name: 'h264_amf', args: '-quality balanced', label: 'AMF (AMD)' });
  } else {
    // Linux
    encoders.push({ name: 'h264_nvenc', args: '-preset p4 -cq 20', label: 'NVENC (NVIDIA)' });
    encoders.push({ name: 'h264_vaapi', args: '-qp 20', label: 'VAAPI (Linux)' });
  }

  // 软件编码兜底
  encoders.push({ name: 'libx264', args: '-preset fast -crf 18', label: 'x264 (软件)' });

  // 检测哪个可用
  for (const enc of encoders) {
    try {
      const output = execSync('ffmpeg -hide_banner -encoders', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      if (output.includes(enc.name)) {
        console.log(`🎯 检测到编码器: ${enc.label}`);
        return enc;
      }
    } catch (e) {
      // 该编码器不可用，继续检测下一个
    }
  }

  // 默认返回软件编码
  return { name: 'libx264', args: '-preset fast -crf 18', label: 'x264 (软件)' };
}

// 缓存编码器检测结果
let cachedEncoder = null;
function getEncoder() {
  if (!cachedEncoder) {
    cachedEncoder = detectEncoder();
  }
  return cachedEncoder;
}

// 内置 FFmpeg 剪辑逻辑（filter_complex 精确剪辑 + buffer + crossfade）
function executeFFmpegCut(input, deleteList, output) {
  // 配置参数
  const envConfig = readEnvConfig();
  const CUT_EXPAND_MS = parseMs(envConfig.CUT_EXPAND_MS, 0);
  const CUT_KEEP_PADDING_MS = parseMs(envConfig.CUT_KEEP_PADDING_MS, 0);
  const CUT_MIN_DELETE_MS = parseMs(envConfig.CUT_MIN_DELETE_MS, 120);
  const CROSSFADE_MS = parseMs(envConfig.CROSSFADE_MS, 30);

  console.log(`⚙️ 优化参数: 边界保留=${CUT_KEEP_PADDING_MS}ms, 最小删除=${CUT_MIN_DELETE_MS}ms, 额外扩展=${CUT_EXPAND_MS}ms, 音频接缝淡化=${CROSSFADE_MS}ms`);

  // 检测审核音频和源视频音频的时间轴映射
  const timelineMetadata = readTimelineMetadata();
  let reviewAudioStartSec = 0;
  try {
    const reviewAudioFile = fs.existsSync('audio.wav') ? 'audio.wav' : 'audio.mp3';
    const offsetCmd = `ffprobe -v error -show_entries format=start_time -of csv=p=0 ${reviewAudioFile}`;
    reviewAudioStartSec = parseFloat(execSync(offsetCmd).toString().trim()) || 0;
  } catch (e) {
    // 忽略，使用默认 0
  }
  const sourceAudioStartSec = probeSourceAudioStartTime(input);
  const timelineOffsetSec = timelineMetadata
    ? Number(timelineMetadata.timelineOffsetSec) || 0
    : sourceAudioStartSec - reviewAudioStartSec;
  if (timelineMetadata) {
    console.log(`🔧 已读取时间轴元数据，导出映射补偿=${timelineOffsetSec.toFixed(3)}s`);
  } else {
    console.log(`🔧 审核音频起点=${reviewAudioStartSec.toFixed(3)}s，源视频音频起点=${sourceAudioStartSec.toFixed(3)}s，导出映射补偿=${timelineOffsetSec.toFixed(3)}s`);
  }

  // 获取视频总时长
  const probeCmd = `ffprobe -v error -show_entries format=duration -of csv=p=0 "${fileArg(input)}"`;

  const duration = parseFloat(execSync(probeCmd).toString().trim());

  const expandSec = CUT_EXPAND_MS / 1000;
  const keepPaddingSec = CUT_KEEP_PADDING_MS / 1000;
  const minDeleteSec = CUT_MIN_DELETE_MS / 1000;
  const crossfadeSec = CROSSFADE_MS / 1000;

  // 补偿偏移 + 收缩删除范围，尽量多保留边界附近的正常文字
  const expandedDelete = buildAdjustedDeleteSegments(deleteList, {
    timelineOffsetSec,
    duration,
    expandSec,
    keepPaddingSec,
    minDeleteSec,
  }).sort((a, b) => a.start - b.start);

  if (expandedDelete.length === 0 && deleteList.length > 0) {
    console.log('⚠️ 当前删除片段都很短，按保留策略收缩后没有可执行的删除范围');
  }

  // 合并重叠的删除段
  const mergedDelete = [];
  for (const seg of expandedDelete) {
    if (mergedDelete.length === 0 || seg.start > mergedDelete[mergedDelete.length - 1].end) {
      mergedDelete.push({ ...seg });
    } else {
      mergedDelete[mergedDelete.length - 1].end = Math.max(mergedDelete[mergedDelete.length - 1].end, seg.end);
    }
  }

  // 计算保留片段
  const keepSegments = [];
  let cursor = 0;

  for (const del of mergedDelete) {
    if (del.start > cursor) {
      keepSegments.push({ start: cursor, end: del.start });
    }
    cursor = del.end;
  }
  if (cursor < duration) {
    keepSegments.push({ start: cursor, end: duration });
  }

  console.log(`保留 ${keepSegments.length} 个片段，删除 ${mergedDelete.length} 个片段`);

  // 生成 filter_complex（保时长淡入淡出）
  let filters = [];
  let vconcat = '';
  let aconcat = '';

  for (let i = 0; i < keepSegments.length; i++) {
    const seg = keepSegments[i];
    filters.push(`[0:v]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    filters.push(buildAudioFilter(seg, i, keepSegments.length, crossfadeSec));
    vconcat += `[v${i}]`;
    aconcat += `[a${i}]`;
  }

  // 视频直接 concat
  filters.push(`${vconcat}concat=n=${keepSegments.length}:v=1:a=0[outv]`);

  // 音频先做轻微淡入淡出，再直接 concat，避免累计缩短总时长
  if (keepSegments.length === 1) {
    filters.push(`[a0]anull[outa]`);
  } else {
    filters.push(`${aconcat}concat=n=${keepSegments.length}:v=0:a=1[outa]`);
  }

  const filterComplex = filters.join(';');

  const encoder = getEncoder();
  console.log(`✂️ 执行 FFmpeg 精确剪辑（${encoder.label}）...`);

  const cmd = `ffmpeg -y -i "${fileArg(input)}" -filter_complex "${filterComplex}" -map "[outv]" -map "[outa]" -c:v ${encoder.name} ${encoder.args} -pix_fmt yuv420p -movflags +faststart -c:a aac -ar 48000 -b:a 192k "${fileArg(output)}"`;

  try {
    execSync(cmd, { stdio: 'pipe' });
    console.log(`✅ 输出: ${output}`);

    const newDuration = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${fileArg(output)}"`).toString().trim());
    console.log(`📹 新时长: ${newDuration.toFixed(2)}s`);
  } catch (err) {
    console.error('FFmpeg 执行失败，尝试分段方案...');
    executeFFmpegCutFallback(input, keepSegments, output);
  }
}

// 备用方案：分段切割 + concat（当 filter_complex 失败时使用）
function executeFFmpegCutFallback(input, keepSegments, output) {
  const tmpDir = `tmp_cut_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const partFiles = [];
    keepSegments.forEach((seg, i) => {
      const partFile = path.join(tmpDir, `part${i.toString().padStart(4, '0')}.mp4`);
      const segDuration = seg.end - seg.start;

      const encoder = getEncoder();
      const cmd = `ffmpeg -y -ss ${seg.start.toFixed(3)} -i "${fileArg(input)}" -t ${segDuration.toFixed(3)} -c:v ${encoder.name} ${encoder.args} -c:a aac -b:a 128k -avoid_negative_ts make_zero "${partFile}"`;

      console.log(`切割片段 ${i + 1}/${keepSegments.length}: ${seg.start.toFixed(2)}s - ${seg.end.toFixed(2)}s`);
      execSync(cmd, { stdio: 'pipe' });
      partFiles.push(partFile);
    });

    const listFile = path.join(tmpDir, 'list.txt');
    const listContent = partFiles.map(f => `file '${path.resolve(f)}'`).join('\n');
    fs.writeFileSync(listFile, listContent);

    const concatCmd = `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${output}"`;
    console.log('合并片段...');
    execSync(concatCmd, { stdio: 'pipe' });

    console.log(`✅ 输出: ${output}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

server.listen(PORT, () => {
  const runtimeInfo = getRuntimeInfo(VIDEO_FILE);
  console.log(`
🎬 审核服务器已启动
📍 地址: http://localhost:${PORT}
📹 视频: ${VIDEO_FILE}
📦 成片输出目录: ${runtimeInfo.cutOutputDir}
⚙️ 输出目录来源: ${runtimeInfo.outputSourceText}
${OUTPUT_ROOT ? `📂 额外复制目录: ${path.resolve(OUTPUT_ROOT)}` : ''}

操作说明:
1. 在网页中审核选择要删除的片段
2. 点击「🎬 执行剪辑」按钮
3. 等待剪辑完成
  `);
});
