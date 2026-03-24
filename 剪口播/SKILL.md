---
name: videocut:剪口播
description: 口播视频转录和口误识别。生成审查稿和删除任务清单。触发词：剪口播、处理视频、识别口误
---

<!--
input: 视频文件 (*.mp4)
output: subtitles_words.json、auto_selected.json、review.html、视频介绍草稿.md
pos: 转录+识别，到用户网页审核为止

架构守护者：一旦我被修改，请同步更新：
1. ../README.md 的 Skill 清单
2. /CLAUDE.md 路由表
-->

# 剪口播 v2

> 语音转录 + AI 口误识别 + 网页审核

补充资料：

- 生成视频介绍草稿时，按 [show-notes.md](show-notes.md) 执行

## 快速使用

```
用户: 帮我剪这个口播视频
用户: 处理一下这个视频
```

## 输出目录结构

```
{DEFAULT_OUTPUT_DIR}/
└── YYYY-MM-DD_视频名/
    ├── 剪口播/
    │   ├── 1_转录/
    │   │   ├── audio.wav
    │   │   ├── audio_timeline.json
    │   │   ├── volcengine_result.json  (仅火山引擎方案)
    │   │   └── subtitles_words.json
    │   ├── 2_分析/
    │   │   ├── readable.txt
    │   │   ├── sentences.txt
    │   │   ├── auto_selected.json
    │   │   └── 口误分析.md
    │   └── 3_审核/
    │       ├── audio_preview.m4a
    │       ├── review.html
    │       └── 视频介绍草稿.md
    └── 字幕/
        └── ...
```

**规则**：已有文件夹则复用，否则新建。

## 流程

```
0. 创建输出目录
    ↓
1. 提取和视频时间轴对齐的审核音频
    ↓
2. 选择转录方案（读取 .env 的 ASR_ENGINE）
    ├─ volcengine: 上传 → 火山引擎 API → generate_subtitles.js
    └─ whisper:    本地 whisper_transcribe.py
    ↓
3. 得到 subtitles_words.json（两条路径汇合）
    ↓
4. AI 分析口误/静音，生成预选列表 (auto_selected.json)
    ↓
4.2 规范化预选列表（补短停顿桥接）
    ↓
4.5 生成视频介绍草稿 (视频介绍草稿.md)
    ↓
5. 生成审核网页 (review.html)
    ↓
6. 启动审核服务器，用户网页确认
    ↓
【等待用户确认】→ 网页点击「执行剪辑」或手动 /剪辑
```

## 执行步骤

### 步骤 0: 创建输出目录

```bash
# 读取 .env 中的 DEFAULT_OUTPUT_DIR
SKILL_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$SKILL_ROOT/.env"
OUTPUT_ROOT=$(grep DEFAULT_OUTPUT_DIR "$ENV_FILE" | cut -d'=' -f2)
```

**如果 `DEFAULT_OUTPUT_DIR` 为空（首次使用）**：
1. 询问用户希望将输出文件存放到哪个目录
2. 将用户回答的路径写入 `.env` 的 `DEFAULT_OUTPUT_DIR=` 行
3. 如果用户没有特别要求，使用视频文件所在目录的 `output/` 子目录

```bash
# 变量设置（根据实际视频调整）
VIDEO_PATH="/path/to/视频.mp4"
VIDEO_NAME=$(basename "$VIDEO_PATH" .mp4)
DATE=$(date +%Y-%m-%d)
BASE_DIR="${OUTPUT_ROOT}/${DATE}_${VIDEO_NAME}/剪口播"

# 创建子目录
mkdir -p "$BASE_DIR/1_转录" "$BASE_DIR/2_分析" "$BASE_DIR/3_审核"
cd "$BASE_DIR"
```

### 步骤 1: 提取音频

```bash
cd 1_转录

# 提取和视频时间轴对齐的审核音频，并写出时间轴元数据
node "$SKILL_DIR/scripts/extract_review_audio.js" "$VIDEO_PATH" audio.wav audio_timeline.json
```

说明：

- 后续 Whisper 转录和审核页都基于这份 `audio.wav`
- `audio_timeline.json` 用来把审核页时间轴和源视频时间轴对齐，避免不同视频的音频起点差异导致切点偏移

### 步骤 2: 转录（分支）

读取 `.env` 中的 `ASR_ENGINE`：
- 如果为空 → 询问用户选择转录方案
- `volcengine` → 方案 A
- `whisper` → 方案 B

#### 方案 A：火山引擎 API

```bash
# 1. 转成便于上传的 mp3
ffmpeg -y -i audio.wav -c:a libmp3lame audio.mp3

# 2. 上传获取公网 URL
curl -s -F "files[]=@audio.mp3" https://uguu.se/upload
# 返回: {"success":true,"files":[{"url":"https://h.uguu.se/xxx.mp3"}]}

# 3. 调用火山引擎 API
node "$SKILL_DIR/scripts/volcengine_transcribe.js" "https://h.uguu.se/xxx.mp3"
# 输出: volcengine_result.json

# 4. 生成字级别字幕
node "$SKILL_DIR/scripts/generate_subtitles.js" volcengine_result.json
# 输出: subtitles_words.json
```

#### 方案 B：Whisper 本地模型

先检查 mlx-whisper 是否已安装，未安装则自动安装：

```bash
python3 -c "import mlx_whisper" 2>/dev/null || pip3 install mlx-whisper
```

执行转录（首次运行会自动下载模型，约 1.5GB）：

```bash
python3 "$SKILL_DIR/scripts/whisper_transcribe.py" audio.wav
# 直接输出: subtitles_words.json（已包含 gap 检测，无需再调 generate_subtitles.js）
```

```bash
cd ..
```

→ 两条路径都输出 `subtitles_words.json`，后续步骤完全一致。

### 步骤 3: 分析口误（脚本+AI）

#### 3.1 生成易读格式

```bash
cd 2_分析

node -e "
const data = require('../1_转录/subtitles_words.json');
let output = [];
data.forEach((w, i) => {
  if (w.isGap) {
    const dur = (w.end - w.start).toFixed(2);
    if (dur >= 0.5) output.push(i + '|[静' + dur + 's]|' + w.start.toFixed(2) + '-' + w.end.toFixed(2));
  } else {
    output.push(i + '|' + w.text + '|' + w.start.toFixed(2) + '-' + w.end.toFixed(2));
  }
});
require('fs').writeFileSync('readable.txt', output.join('\\n'));
"
```

#### 3.2 读取用户习惯

先读 `用户习惯/` 目录下所有规则文件。

#### 3.3 生成句子列表（关键步骤）

**必须先分句，再分析**。按静音切分成句子列表：

```bash
node -e "
const data = require('../1_转录/subtitles_words.json');
let sentences = [];
let curr = { text: '', startIdx: -1, endIdx: -1 };

data.forEach((w, i) => {
  const isLongGap = w.isGap && (w.end - w.start) >= 0.5;
  if (isLongGap) {
    if (curr.text.length > 0) sentences.push({...curr});
    curr = { text: '', startIdx: -1, endIdx: -1 };
  } else if (!w.isGap) {
    if (curr.startIdx === -1) curr.startIdx = i;
    curr.text += w.text;
    curr.endIdx = i;
  }
});
if (curr.text.length > 0) sentences.push(curr);

sentences.forEach((s, i) => {
  console.log(i + '|' + s.startIdx + '-' + s.endIdx + '|' + s.text);
});
" > sentences.txt
```

#### 3.4 脚本自动标记静音（必须先执行）

```bash
node -e "
const words = require('../1_转录/subtitles_words.json');
const selected = [];
words.forEach((w, i) => {
  if (w.isGap && (w.end - w.start) >= 0.5) selected.push(i);
});
require('fs').writeFileSync('auto_selected.json', JSON.stringify(selected, null, 2));
console.log('≥0.5s静音数量:', selected.length);
"
```

→ 输出 `auto_selected.json`（只含静音 idx）

#### 3.5 AI 分析口误（追加到 auto_selected.json）

**检测规则（按优先级）**：

| # | 类型 | 判断方法 | 删除范围 |
|---|------|----------|----------|
| 1 | 重复句 | 相邻句子开头≥5字相同 | 较短的**整句** |
| 2 | 隔一句重复 | 中间是残句时，比对前后句 | 前句+残句 |
| 3 | 残句 | 话说一半+静音 | **整个残句** |
| 4 | 句内重复 | A+中间+A 模式 | 前面部分 |
| 5 | 卡顿词 | 那个那个、就是就是 | 前面部分 |
| 6 | 重说纠正 | 部分重复/否定纠正 | 前面部分 |
| 7 | 语气词 | 嗯、啊、那个 | 标记但不自动删 |

**核心原则**：
- **先分句，再比对**：用 sentences.txt 比对相邻句子
- **整句删除**：残句、重复句都要删整句，不只是删异常的几个字

**分段分析（循环执行）**：

```
1. Read readable.txt offset=N limit=300
2. 结合 sentences.txt 分析这300行
3. 追加口误 idx 到 auto_selected.json
4. 记录到 口误分析.md
5. N += 300，回到步骤1
```

🚨 **关键警告：行号 ≠ idx**

```
readable.txt 格式: idx|内容|时间
                   ↑ 用这个值

行号1500 → "1568|[静1.02s]|..."  ← idx是1568，不是1500！
```

**口误分析.md 格式：**

```markdown
## 第N段 (行号范围)

| idx | 时间 | 类型 | 内容 | 处理 |
|-----|------|------|------|------|
| 65-75 | 15.80-17.66 | 重复句 | "这是我剪出来的一个案例" | 删 |
```

#### 3.6 自动清理孤立小间隙

被删句子之间夹着的短 gap 也应自动标记删除，避免审核页留下碎片：

```bash
node -e "
const words = require('../1_转录/subtitles_words.json');
const selected = new Set(require('./auto_selected.json'));
let added = 0;
words.forEach((w, i) => {
  if (!w.isGap || selected.has(i)) return;
  let prev = i - 1;
  while (prev >= 0 && words[prev].isGap) prev--;
  let next = i + 1;
  while (next < words.length && words[next].isGap) next++;
  if (prev >= 0 && next < words.length && selected.has(prev) && selected.has(next)) {
    selected.add(i);
    added++;
  }
});
const sorted = Array.from(selected).sort((a, b) => a - b);
require('fs').writeFileSync('auto_selected.json', JSON.stringify(sorted, null, 2) + '\\n');
if (added) console.log('🧹 自动清理孤立小间隙:', added, '个');
"
```

#### 3.7 规范化预选列表（必须执行）

AI 补完索引后，再执行一次规范化，补上夹在两个待删片段之间的短停顿：

```bash
node "$SKILL_DIR/scripts/refine_auto_selected.js" \
  "../1_转录/subtitles_words.json" \
  "auto_selected.json"
```

补充规则：

- 如果一个 `<0.5s` 的停顿，前后最近的口播词都已经在 `auto_selected.json` 里，这个停顿也默认删掉
- 长静音在 `subtitles_words.json` 里会按整段保留，不再拆成很多个 `1.0s`

### 步骤 4.5: 生成 AI 视频介绍草稿

这一步必须由 Claude 直接完成，不要用本地模板脚本代写。

按 [show-notes.md](show-notes.md) 的要求，基于当前准备保留的内容生成：

```text
../3_审核/视频介绍草稿.md
```

要求：

- 风格像创作者自己会配在视频旁边发出的介绍文案
- 默认包含标题、正文、标签、内容摘要
- 如果当前口播还是半成品，正文也要跟着真实，不要编造视频里没讲过的内容
- 审核页里默认只展示和复制这份草稿，不依赖用户在页面里手工保存

### 步骤 4-5: 审核

```bash
cd ../3_审核

# 6. 生成审核网页
node "$SKILL_DIR/scripts/generate_review.js" ../1_转录/subtitles_words.json ../2_分析/auto_selected.json ../1_转录/audio.wav
# 输出: review.html

# 7. 启动审核服务器
node "$SKILL_DIR/scripts/review_server.js" 8899 "$VIDEO_PATH"
# 打开 http://localhost:8899
```

用户在网页中：
- 播放视频片段确认
- 勾选/取消删除项
- 直接复制 AI 生成的视频介绍草稿
- 点击「执行剪辑」

注意：

- 审核页会自动生成 `audio_preview.m4a` 作为浏览器预览音频，避免直接播放大 `wav` 时的噪音问题
- `audio_timeline.json` 会一并复制到审核目录，导出时按每个视频动态校准时间轴，不写死固定偏移

---

## 数据格式

### subtitles_words.json

```json
[
  {"text": "大", "start": 0.12, "end": 0.2, "isGap": false},
  {"text": "", "start": 6.78, "end": 7.48, "isGap": true}
]
```

### auto_selected.json

```json
[72, 85, 120]  // Claude 分析生成的预选索引
```

---

## 配置

### .env 字段

```bash
VOLCENGINE_API_KEY=xxx    # 火山引擎 API Key（方案 A 需要）
DEFAULT_OUTPUT_DIR=xxx    # 默认输出目录
ASR_ENGINE=               # 转录方案: volcengine / whisper，留空每次询问
CUT_KEEP_PADDING_MS=300   # 保留片段语音边界前后缓冲
CUT_MIN_DELETE_MS=120     # 小于该时长的删除段默认忽略
CROSSFADE_MS=30           # 片段音频接缝淡化
```

### 火山引擎 API Key

获取指南：https://my.feishu.cn/wiki/Gh0MwxHePidsYfkIx7zcvJQynqc?from=from_copylink

```bash
# 编辑 .env 填入 VOLCENGINE_API_KEY=xxx
```
