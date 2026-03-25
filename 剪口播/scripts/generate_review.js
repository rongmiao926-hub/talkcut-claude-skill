#!/usr/bin/env node
/**
 * 生成审核网页（wavesurfer.js 版本）
 *
 * 用法: node generate_review.js <subtitles_words.json> [auto_selected.json] [audio_file]
 * 输出: review.html, audio.*（复制到当前目录）
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { normalizeSelectedIndices } = require('./auto_selected_utils');

const subtitlesFile = process.argv[2] || 'subtitles_words.json';
const autoSelectedFile = process.argv[3] || 'auto_selected.json';
const audioFile = process.argv[4] || 'audio.wav';

// 复制音频文件到当前目录（避免相对路径问题）
const inputAudioExt = path.extname(audioFile) || '.wav';
const audioBaseName = `audio${inputAudioExt}`;
if (audioFile !== audioBaseName && fs.existsSync(audioFile)) {
  fs.copyFileSync(audioFile, audioBaseName);
  console.log('📁 已复制音频到当前目录:', audioBaseName);
}

// 审核时优先直接播放提取出来的原始 WAV，避免为了前端预览再做一层有损 AAC 压缩。
const reviewAudioBaseName = audioBaseName;
let previewAudioBaseName = reviewAudioBaseName;
let previewAudioOffsetSec = 0;

const timelineMetadataSource = path.join(path.dirname(audioFile), 'audio_timeline.json');
if (fs.existsSync(timelineMetadataSource)) {
  fs.copyFileSync(timelineMetadataSource, 'audio_timeline.json');
  console.log('📁 已复制时间轴元数据到当前目录: audio_timeline.json');

  try {
    const timelineMetadata = JSON.parse(fs.readFileSync(timelineMetadataSource, 'utf8'));
    const sourceVideo = String(timelineMetadata.sourceVideo || '').trim();
    const sourceAudioStartSec = Number(timelineMetadata.sourceAudioStartSec);
    const previewSourceName = 'audio_source.wav';

    if (Number.isFinite(sourceAudioStartSec)) {
      if (sourceVideo && fs.existsSync(sourceVideo)) {
        const previewIsFresh = fs.existsSync(previewSourceName)
          && fs.statSync(previewSourceName).mtimeMs >= fs.statSync(sourceVideo).mtimeMs;

        if (!previewIsFresh) {
          execSync(
            `ffmpeg -y -i "${sourceVideo}" -map 0:a:0 -c:a pcm_s16le "${previewSourceName}"`,
            { stdio: 'pipe' }
          );
          console.log('🎧 已生成源音轨预览音频:', previewSourceName);
        }
      } else if (fs.existsSync(previewSourceName)) {
        console.log('🎧 源视频路径已变化，继续复用当前目录里的源音轨预览音频:', previewSourceName);
      }

      if (fs.existsSync(previewSourceName)) {
        previewAudioBaseName = previewSourceName;
        previewAudioOffsetSec = sourceAudioStartSec;
      }
    }
  } catch (err) {
    console.warn('⚠️ 解析时间轴元数据或生成源音轨预览失败，将回退到对齐审核音频播放');
  }
}

if (!fs.existsSync(subtitlesFile)) {
  console.error('❌ 找不到字幕文件:', subtitlesFile);
  process.exit(1);
}

const words = JSON.parse(fs.readFileSync(subtitlesFile, 'utf8'));
let autoSelected = [];

if (fs.existsSync(autoSelectedFile)) {
  const rawAutoSelected = JSON.parse(fs.readFileSync(autoSelectedFile, 'utf8'));
  const normalized = normalizeSelectedIndices(words, rawAutoSelected);
  autoSelected = normalized.indices;
  console.log('AI 预选:', autoSelected.length, '个元素');
  if (normalized.addedBridgeGaps > 0) {
    console.log('🔗 已补充夹在删除段之间的短停顿:', normalized.addedBridgeGaps, '个');
  }
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>审核稿</title>
  <script src="https://unpkg.com/wavesurfer.js@7"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
      max-width: 960px;
      margin: 0 auto;
      padding: 24px 20px 100px;
      background: #f8f9fa;
      color: #1a1a1a;
      -webkit-user-select: none;
      user-select: none;
    }
    textarea, input {
      -webkit-user-select: text;
      user-select: text;
    }

    /* ── 顶部播放器区域 ── */
    .player {
      position: sticky;
      top: 0;
      background: #f8f9fa;
      padding: 16px 0 12px;
      z-index: 100;
      border-bottom: 1px solid #e0e0e0;
    }
    .player-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    .btn {
      padding: 7px 14px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: opacity .15s;
    }
    .btn:hover { opacity: .85; }
    .btn-play { background: #2563eb; color: #fff; }
    .btn-cut  { background: #111; color: #fff; }
    .btn-clear {
      background: #fff;
      color: #999;
      border: 1px solid #d0d0d0;
      font-size: 12px;
      padding: 5px 12px;
    }
    .btn-clear:hover { color: #dc2626; border-color: #fca5a5; }

    select {
      padding: 7px 10px;
      background: #fff;
      color: #333;
      border: 1px solid #d0d0d0;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
    }
    .time-display {
      margin-left: auto;
      font-family: "SF Mono", Menlo, monospace;
      font-size: 14px;
      color: #999;
      margin-right: 4px;
    }
    .native-audio {
      width: 100%;
      margin: 10px 0 0;
    }
    #waveform {
      background: #fff;
      border-radius: 8px;
      border: 1px solid #e0e0e0;
      overflow: hidden;
    }

    /* ── 操作说明 ── */
    .help-section {
      margin-top: 14px;
      padding: 14px 16px;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      font-size: 13px;
      color: #555;
      line-height: 1.8;
    }
    .help-section .help-title {
      font-weight: 600;
      color: #333;
      margin-bottom: 6px;
    }
    .help-section ul {
      list-style: none;
      padding: 0;
    }
    .help-section li {
      padding: 2px 0;
    }
    .help-section li::before {
      content: "·";
      margin-right: 8px;
      color: #aaa;
    }
    .help-section kbd {
      display: inline-block;
      padding: 1px 6px;
      background: #f3f4f6;
      border: 1px solid #d1d5db;
      border-radius: 4px;
      font-family: "SF Mono", Menlo, monospace;
      font-size: 12px;
      color: #555;
    }

    /* ── 统计栏 ── */
    .stats-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 0;
      margin-top: 8px;
      font-size: 13px;
      color: #888;
      border-bottom: 1px solid #e5e7eb;
    }
    .legend {
      display: flex;
      gap: 14px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 2px;
    }

    /* ── 正文区 ── */
    .content {
      line-height: 2.6;
      padding: 16px 0;
    }

    .word {
      display: inline-block;
      padding: 3px 2px;
      margin: 1px;
      border-radius: 3px;
      cursor: pointer;
      transition: background .1s, color .1s;
      position: relative;
    }
    .word:hover { background: #e8e8e8; }
    .word.current { background: #2563eb; color: #fff; }

    /* AI 预选但用户取消了：只留淡底色提示，表示"AI 曾标记" */
    .word.ai-origin { background: #fefce8; color: #a16207; border-bottom: 1.5px dashed #e5be2b; }
    .word.ai-origin:hover { background: #fef9c3; }

    /* 手动确认删除：红色删除线 */
    .word.selected { background: #fee2e2; color: #991b1b; text-decoration: line-through; }

    /* AI 预选 + 已确认删除：明显橙色 + 删除线 */
    .word.ai-origin.selected { background: #fef3c7; color: #92400e; text-decoration: line-through; border-bottom: none; }

    /* 拖动时临时高亮 */
    .word.drag-preview { outline: 2px solid #f59e0b; outline-offset: -1px; }

    .gap {
      display: inline-block;
      background: #f0f0f0;
      color: #999;
      padding: 3px 7px;
      margin: 1px;
      border-radius: 3px;
      font-size: 11px;
      cursor: pointer;
      transition: background .1s;
    }
    .gap:hover { background: #e0e0e0; }
    .gap.ai-origin { background: #fefce8; color: #a16207; border-bottom: 1.5px dashed #e5be2b; }
    .gap.selected { background: #fee2e2; color: #991b1b; }
    .gap.ai-origin.selected { background: #fef3c7; color: #92400e; text-decoration: line-through; border-bottom: none; }
    .gap.drag-preview { outline: 2px solid #f59e0b; outline-offset: -1px; }

    /* ── 底部操作栏 ── */
    .bottom-bar {
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid #e5e7eb;
    }
    .bottom-bar-row {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .btn-copy {
      background: #e5e7eb;
      color: #555;
      font-size: 12px;
      padding: 6px 12px;
    }
    .btn-copy:hover { background: #d1d5db; }
    .copy-hint {
      margin-top: 10px;
      font-size: 12px;
      color: #9ca3af;
      line-height: 1.6;
    }
    .show-notes-panel {
      margin-top: 18px;
      padding: 18px;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
    }
    .show-notes-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
    }
    .show-notes-title {
      font-size: 16px;
      font-weight: 600;
      color: #111827;
    }
    .show-notes-subtitle {
      margin-top: 4px;
      font-size: 13px;
      color: #6b7280;
      line-height: 1.6;
    }
    .show-notes-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .show-notes-status {
      margin-top: 12px;
      min-height: 20px;
      font-size: 13px;
      color: #6b7280;
    }
    .show-notes-output {
      width: 100%;
      min-height: 240px;
      margin-top: 12px;
      padding: 14px;
      border: 1px solid #d1d5db;
      border-radius: 10px;
      background: #fffbeb;
      color: #374151;
      font-size: 14px;
      line-height: 1.8;
      resize: vertical;
    }
    .show-notes-output:focus {
      outline: 2px solid #fdba74;
      border-color: #fb923c;
    }
    .output-dir-panel {
      margin-top: 16px;
      padding: 14px 16px;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
    }
    .output-dir-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .output-dir-title {
      font-size: 14px;
      font-weight: 600;
      color: #111827;
    }
    .output-dir-value {
      margin-top: 6px;
      font-family: "SF Mono", Menlo, monospace;
      font-size: 12px;
      line-height: 1.7;
      color: #374151;
      word-break: break-all;
    }
    .output-dir-status {
      margin-top: 6px;
      font-size: 12px;
      line-height: 1.6;
      color: #6b7280;
    }

    /* ── 页脚署名 ── */
    .footer-credit {
      margin-top: 32px;
      padding-top: 14px;
      border-top: 1px solid #e5e7eb;
      font-size: 11px;
      color: #b0b0b0;
      line-height: 1.7;
      text-align: center;
    }

    /* ── Loading 遮罩 ── */
    .loading-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(255,255,255,0.92);
      z-index: 9999;
      justify-content: center;
      align-items: center;
      flex-direction: column;
    }
    .loading-overlay.show { display: flex; }
    .loading-spinner {
      width: 48px; height: 48px;
      border: 3px solid #e5e7eb;
      border-top-color: #7c3aed;
      border-radius: 50%;
      animation: spin .8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-text { margin-top: 18px; font-size: 16px; color: #333; }
    .loading-progress-container {
      margin-top: 16px; width: 260px; height: 6px;
      background: #e5e7eb; border-radius: 3px; overflow: hidden;
    }
    .loading-progress-bar {
      height: 100%;
      background: linear-gradient(90deg, #7c3aed, #ec4899);
      width: 0%; transition: width .3s;
    }
    .loading-time { margin-top: 12px; font-size: 13px; color: #666; }
    .loading-estimate { margin-top: 6px; font-size: 12px; color: #999; }
  </style>
</head>
<body>
  <!-- Loading 遮罩 -->
  <div class="loading-overlay" id="loadingOverlay">
    <div class="loading-spinner"></div>
    <div class="loading-text">正在剪辑...</div>
    <div class="loading-progress-container">
      <div class="loading-progress-bar" id="loadingProgress"></div>
    </div>
    <div class="loading-time" id="loadingTime">已等待 0 秒</div>
    <div class="loading-estimate" id="loadingEstimate"></div>
  </div>

  <!-- 顶部播放器 -->
  <div class="player">
    <div class="player-row">
      <button class="btn btn-play" onclick="wavesurfer.playPause()">播放 / 暂停</button>
      <select id="speed" onchange="wavesurfer.setPlaybackRate(parseFloat(this.value))">
        <option value="0.5">0.5x</option>
        <option value="0.75">0.75x</option>
        <option value="1" selected>1x</option>
        <option value="1.25">1.25x</option>
        <option value="1.5">1.5x</option>
        <option value="2">2x</option>
      </select>
      <span class="time-display" id="time">00:00 / 00:00</span>
      <button class="btn btn-cut" onclick="executeCut()">执行剪辑</button>
    </div>
    <audio id="nativeAudio" class="native-audio" controls preload="metadata" src="${previewAudioBaseName}"></audio>
    <div id="waveform"></div>
    <div class="help-section">
      <div class="help-title">操作说明</div>
      <ul>
        <li><strong>单击</strong>文字：跳转到该位置播放</li>
        <li><strong>拖动</strong>鼠标：框选一段文字，松开后批量选中（再次拖动已选中的区域可取消）</li>
        <li><strong>双击</strong>文字：选中或取消单个字</li>
        <li>键盘快捷键：<kbd>空格</kbd> 播放/暂停，<kbd>←</kbd><kbd>→</kbd> 前后跳 1 秒，<kbd>Shift</kbd>+方向键跳 5 秒</li>
        <li>默认使用源视频主音轨做试听，WaveSurfer 只负责波形和定位</li>
      </ul>
    </div>
  </div>

  <div class="output-dir-panel">
    <div class="output-dir-header">
      <div>
        <div class="output-dir-title">本次成片输出目录</div>
        <div class="output-dir-value" id="outputDirValue">正在读取...</div>
        <div class="output-dir-status" id="outputDirStatus">页面会自动读取当前实际输出目录。</div>
      </div>
      <button class="btn btn-copy" onclick="copyOutputDir()">复制目录</button>
    </div>
  </div>

  <!-- 统计 + 图例 + 清空 -->
  <div class="stats-bar">
    <span id="stats">已选择 0 个，共 0.00s</span>
    <div class="legend">
      <div class="legend-item"><div class="legend-dot" style="background:#fef3c7; border: 1px solid #e5be2b"></div>AI 预选（待删除）</div>
      <div class="legend-item"><div class="legend-dot" style="background:#fefce8; border: 1px dashed #e5be2b"></div>AI 预选（手动保留）</div>
      <div class="legend-item"><div class="legend-dot" style="background:#fee2e2; border: 1px solid #fca5a5"></div>手动选中</div>
      <div class="legend-item"><div class="legend-dot" style="background:#2563eb"></div>正在播放</div>
    </div>
    <button class="btn btn-clear" onclick="clearAll()">清空选择</button>
  </div>

  <!-- 正文 -->
  <div class="content" id="content"></div>

  <!-- 底部操作 -->
  <div class="bottom-bar">
    <div class="bottom-bar-row">
      <button class="btn btn-copy" onclick="copyDeleteList()">复制删除列表 (JSON)</button>
    </div>
    <div class="copy-hint">💡 复制后发送给你的 AI 助手，它可以从中学习你的剪辑偏好，下次自动标记得更准。</div>
  </div>

  <div class="show-notes-panel">
    <div class="show-notes-header">
      <div>
        <div class="show-notes-title">视频介绍草稿</div>
        <div class="show-notes-subtitle">这部分内容由 Codex 在主流程里生成，这里只负责查看和复制。</div>
      </div>
      <div class="show-notes-actions">
        <button class="btn btn-copy" onclick="copyShowNotes()">复制视频介绍</button>
      </div>
    </div>
    <div class="show-notes-status" id="showNotesStatus">页面会自动尝试读取已生成的视频介绍草稿。</div>
    <textarea id="showNotesOutput" class="show-notes-output" placeholder="如果这里为空，说明这次流程还没有生成 AI 视频介绍草稿。" readonly></textarea>
  </div>

  <!-- 页脚署名 -->
  <div class="footer-credit">
    原作：成峰（公众号「AI 产品自由」） · 当前版本由 Dogtor 大王（小红书）完善
  </div>

  <script>
    const words = ${JSON.stringify(words)};
    const autoSelected = new Set(${JSON.stringify(autoSelected)});
    const selected = new Set(autoSelected);
    const nativeAudio = document.getElementById('nativeAudio');
    const previewAudioOffsetSec = ${JSON.stringify(previewAudioOffsetSec)};

    const wavesurfer = WaveSurfer.create({
      container: '#waveform',
      backend: 'MediaElement',
      media: nativeAudio,
      waveColor: '#c4c9d4',
      progressColor: '#2563eb',
      cursorColor: '#f59e0b',
      height: 64,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
    });

    const timeDisplay = document.getElementById('time');
    const content = document.getElementById('content');
    const statsDiv = document.getElementById('stats');
    const showNotesStatus = document.getElementById('showNotesStatus');
    const showNotesOutput = document.getElementById('showNotesOutput');
    const outputDirValue = document.getElementById('outputDirValue');
    const outputDirStatus = document.getElementById('outputDirStatus');
    let elements = [];
    let runtimeInfo = null;

    // ── 拖动选择状态 ──
    let isDragging = false;
    let dragStartIdx = -1;
    let dragMode = 'add';
    let dragMoved = false;
    let dragPreviewSet = new Set();
    let suppressAutoScrollUntil = 0;

    function timelineToPreviewTime(sec) {
      return Math.max(0, sec - previewAudioOffsetSec);
    }

    function previewToTimelineTime(sec) {
      return sec + previewAudioOffsetSec;
    }

    function formatTime(sec) {
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return \`\${m.toString().padStart(2, '0')}:\${s.toString().padStart(2, '0')}\`;
    }

    function formatDuration(sec) {
      const totalSec = parseFloat(sec);
      const m = Math.floor(totalSec / 60);
      const s = (totalSec % 60).toFixed(1);
      return m > 0 ? \`\${m}分\${s}秒 (\${totalSec}s)\` : \`\${s}秒\`;
    }

    function suppressAutoScroll(ms = 350) {
      suppressAutoScrollUntil = Date.now() + ms;
    }

    function applyClass(el, i) {
      el.classList.remove('selected', 'ai-origin', 'drag-preview');
      if (selected.has(i)) {
        el.classList.add('selected');
        if (autoSelected.has(i)) el.classList.add('ai-origin');
      } else if (autoSelected.has(i)) {
        el.classList.add('ai-origin');
      }
    }

    // ── 渲染 ──
    function render() {
      content.innerHTML = '';
      elements = [];

      words.forEach((word, i) => {
        const div = document.createElement('div');
        div.className = word.isGap ? 'gap' : 'word';
        applyClass(div, i);

        if (word.isGap) {
          const duration = (word.end - word.start).toFixed(1);
          div.textContent = \`\${duration}s\`;
        } else {
          div.textContent = word.text;
        }
        div.dataset.index = i;

        // 鼠标按下：开始拖动
        div.addEventListener('mousedown', e => {
          isDragging = true;
          dragMoved = false;
          dragStartIdx = i;
          dragMode = selected.has(i) ? 'remove' : 'add';
          clearDragPreview();
          e.preventDefault();
        });

        content.appendChild(div);
        elements.push(div);
      });

      updateStats();
    }

    function clearDragPreview() {
      dragPreviewSet.forEach(j => {
        if (elements[j]) elements[j].classList.remove('drag-preview');
      });
      dragPreviewSet.clear();
    }

    // ── 拖动中：实时显示高亮预览 ──
    content.addEventListener('mousemove', e => {
      if (!isDragging) return;
      const target = e.target.closest('[data-index]');
      if (!target) return;

      const i = parseInt(target.dataset.index);
      if (i !== dragStartIdx) dragMoved = true;

      clearDragPreview();

      const min = Math.min(dragStartIdx, i);
      const max = Math.max(dragStartIdx, i);
      for (let j = min; j <= max; j++) {
        elements[j].classList.add('drag-preview');
        dragPreviewSet.add(j);
      }
    });

    // ── 鼠标松开：执行选择或单击跳转 ──
    document.addEventListener('mouseup', e => {
      if (!isDragging) return;

      const target = e.target.closest('[data-index]');
      const endIdx = target ? parseInt(target.dataset.index) : dragStartIdx;

      clearDragPreview();

      if (!dragMoved) {
        // 没有移动 = 单击 → 跳转播放
        suppressAutoScroll();
        wavesurfer.setTime(timelineToPreviewTime(words[dragStartIdx].start));
      } else {
        // 有移动 = 拖动 → 批量选中/取消
        const min = Math.min(dragStartIdx, endIdx);
        const max = Math.max(dragStartIdx, endIdx);
        for (let j = min; j <= max; j++) {
          if (dragMode === 'add') selected.add(j);
          else selected.delete(j);
          applyClass(elements[j], j);
        }
        updateStats();
      }

      isDragging = false;
      dragStartIdx = -1;
    });

    // 双击选中/取消
    content.addEventListener('dblclick', e => {
      const target = e.target.closest('[data-index]');
      if (!target) return;
      suppressAutoScroll();
      const i = parseInt(target.dataset.index);
      if (selected.has(i)) selected.delete(i);
      else selected.add(i);
      applyClass(elements[i], i);
      updateStats();
    });

    function updateStats() {
      let totalDuration = 0;
      selected.forEach(i => { totalDuration += words[i].end - words[i].start; });
      statsDiv.textContent = \`已选择 \${selected.size} 个，共 \${totalDuration.toFixed(2)}s\`;
    }

    // ── 播放跟踪 ──
    wavesurfer.on('timeupdate', (rawTime) => {
      const t = previewToTimelineTime(rawTime);
      const allowAutoScroll = wavesurfer.isPlaying() && Date.now() >= suppressAutoScrollUntil;
      timeDisplay.textContent = \`\${formatTime(t)} / \${formatTime(previewToTimelineTime(wavesurfer.getDuration()))}\`;
      elements.forEach((el, i) => {
        const w = words[i];
        if (t >= w.start && t < w.end) {
          if (!el.classList.contains('current')) {
            el.classList.add('current');
            if (allowAutoScroll) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }
        } else {
          el.classList.remove('current');
        }
      });
    });

    function copyDeleteList() {
      const merged = getMergedSelectedSegments();
      navigator.clipboard.writeText(JSON.stringify(merged, null, 2)).then(() => {
        alert('已复制 ' + merged.length + ' 个删除片段');
      });
    }

    function getSelectedIndices() {
      return Array.from(selected).sort((a, b) => a - b);
    }

    function getMergedSelectedSegments() {
      const segments = [];
      getSelectedIndices().forEach(i => {
        segments.push({ start: words[i].start, end: words[i].end });
      });

      const merged = [];
      for (const seg of segments) {
        if (merged.length === 0) merged.push({ ...seg });
        else {
          const last = merged[merged.length - 1];
          if (Math.abs(seg.start - last.end) < 0.05) last.end = seg.end;
          else merged.push({ ...seg });
        }
      }
      return merged;
    }

    function clearAll() {
      selected.clear();
      elements.forEach((el, i) => applyClass(el, i));
      updateStats();
    }

    async function loadRuntimeInfo() {
      outputDirStatus.textContent = '正在读取当前实际输出目录...';
      try {
        const res = await fetch('/api/runtime-info');
        const data = await res.json();
        if (!data.success) {
          throw new Error('输出目录读取失败');
        }
        runtimeInfo = data;
        outputDirValue.textContent = data.cutOutputDir;
        outputDirStatus.textContent = data.outputSourceText;
      } catch (err) {
        outputDirValue.textContent = '当前无法读取';
        outputDirStatus.textContent = err.message;
      }
    }

    function copyOutputDir() {
      const text = runtimeInfo?.cutOutputDir || outputDirValue.textContent.trim();
      if (!text || text === '当前无法读取') {
        alert('当前还没有可复制的输出目录');
        return;
      }
      navigator.clipboard.writeText(text).then(() => {
        outputDirStatus.textContent = '输出目录已复制到剪贴板';
      }).catch(err => {
        outputDirStatus.textContent = '复制失败：' + err.message;
      });
    }

    async function loadShowNotes() {
      showNotesStatus.textContent = '正在读取 AI 视频介绍草稿...';
      try {
        const res = await fetch('/api/show-notes');
        const data = await res.json();
        if (!data.success) {
          throw new Error(data.error || '视频介绍草稿读取失败');
        }
        showNotesOutput.value = data.text;
        showNotesStatus.textContent = '已读取 AI 视频介绍草稿：' + data.output;
      } catch (err) {
        showNotesStatus.textContent = err.message;
      }
    }

    function copyShowNotes() {
      const text = showNotesOutput.value.trim();
      if (!text) {
        alert('当前还没有可复制的视频介绍草稿');
        return;
      }
      navigator.clipboard.writeText(text).then(() => {
        showNotesStatus.textContent = '视频介绍草稿已复制到剪贴板';
      }).catch(err => {
        showNotesStatus.textContent = '复制失败：' + err.message;
      });
    }

    async function executeCut() {
      const videoDuration = previewToTimelineTime(wavesurfer.getDuration());
      const videoMinutes = (videoDuration / 60).toFixed(1);
      const estimatedTime = Math.max(5, Math.ceil(videoDuration / 4));
      const estText = estimatedTime >= 60
        ? \`\${Math.floor(estimatedTime/60)}分\${estimatedTime%60}秒\`
        : \`\${estimatedTime}秒\`;

      if (!confirm(\`确认执行剪辑？\\n\\n视频时长: \${videoMinutes} 分钟\\n预计耗时: \${estText}\`)) return;

      const segments = getMergedSelectedSegments();

      const overlay = document.getElementById('loadingOverlay');
      const loadingTimeEl = document.getElementById('loadingTime');
      const loadingProgress = document.getElementById('loadingProgress');
      const loadingEstimate = document.getElementById('loadingEstimate');
      overlay.classList.add('show');
      loadingEstimate.textContent = \`预估剩余: \${estText}\`;

      const startTime = Date.now();
      const timer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        loadingTimeEl.textContent = \`已等待 \${elapsed} 秒\`;
        loadingProgress.style.width = Math.min(95, (elapsed / estimatedTime) * 100) + '%';
        const remaining = Math.max(0, estimatedTime - elapsed);
        loadingEstimate.textContent = remaining > 0 ? \`预估剩余: \${remaining} 秒\` : \`即将完成...\`;
      }, 500);

      try {
        const res = await fetch('/api/cut', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(segments)
        });
        const data = await res.json();
        clearInterval(timer);
        loadingProgress.style.width = '100%';
        await new Promise(r => setTimeout(r, 300));
        overlay.classList.remove('show');
        loadingProgress.style.width = '0%';
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

        if (data.success) {
          alert(\`剪辑完成 (耗时 \${totalTime}s)\\n\\n输出目录: \${data.outputDir}\\n输出文件: \${data.output}\\n原时长: \${formatDuration(data.originalDuration)}\\n新时长: \${formatDuration(data.newDuration)}\\n删减: \${formatDuration(data.deletedDuration)} (\${data.savedPercent}%)\`);
        } else {
          alert('剪辑失败: ' + data.error);
        }
      } catch (err) {
        clearInterval(timer);
        overlay.classList.remove('show');
        loadingProgress.style.width = '0%';
        alert('请求失败: ' + err.message + '\\n\\n请确保使用 review_server.js 启动服务');
      }
    }

    document.addEventListener('keydown', e => {
      if (e.code === 'Space') { e.preventDefault(); wavesurfer.playPause(); }
      else if (e.code === 'ArrowLeft') { wavesurfer.setTime(Math.max(0, wavesurfer.getCurrentTime() - (e.shiftKey ? 5 : 1))); }
      else if (e.code === 'ArrowRight') { wavesurfer.setTime(wavesurfer.getCurrentTime() + (e.shiftKey ? 5 : 1)); }
    });

    render();
    loadRuntimeInfo();
    loadShowNotes();
  </script>
</body>
</html>`;

fs.writeFileSync('review.html', html);
console.log('✅ 已生成 review.html');
console.log('📌 请使用 review_server.js 启动审核服务，否则剪辑和正文读写功能不可用');
