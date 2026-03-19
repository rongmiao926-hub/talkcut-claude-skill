---
name: videocut:安装
description: 环境准备。安装依赖、配置 API Key、验证环境。触发词：安装、环境准备、初始化
---

<!--
input: 无
output: 环境就绪
pos: 前置 skill，首次使用前运行

架构守护者：一旦我被修改，请同步更新：
1. ../README.md 的 Skill 清单
2. /CLAUDE.md 路由表
-->

# 安装

> 首次使用前的环境准备

## 快速使用

```
用户: 安装环境
用户: 初始化
```

## 依赖清单

| 依赖 | 用途 | 安装命令 |
|------|------|----------|
| Node.js | 运行脚本 | `brew install node` |
| FFmpeg | 视频剪辑 | `brew install ffmpeg` |
| curl | API 调用 | 系统自带 |
| mlx-whisper | 本地语音转录（可选） | `pip3 install mlx-whisper` |

## 转录方案

本工具支持两种语音转录方案，用户可任选其一：

| 方案 | 速度 | 费用 | 说明 |
|------|------|------|------|
| 火山引擎 API | 快（云端处理） | 免费 20 小时额度 | 需要 API Key、需要联网 |
| Whisper 本地 | 较慢（本地运算） | 完全免费 | 占用约 1.5GB 磁盘空间，首次使用自动下载模型 |

选择写入 `.env` 的 `ASR_ENGINE` 字段（`volcengine` 或 `whisper`），留空则每次执行时询问。

## API 配置

### 火山引擎语音识别

控制台：https://console.volcengine.com/speech/new/experience/asr?projectName=default

1. 注册火山引擎账号
2. 开通语音识别服务
3. 获取 API Key

配置到项目目录 `.claude/skills/.env`：

```bash
# 文件路径：剪辑Agent/.claude/skills/.env
VOLCENGINE_API_KEY=your_api_key_here
```

## 安装流程

```
1. 安装 Node.js + FFmpeg
       ↓
2. 选择转录方案（火山引擎 / Whisper）
       ↓
3. 配置所选方案（API Key 或安装 mlx-whisper）
       ↓
4. 配置默认输出目录
       ↓
5. 验证环境
```

## 执行步骤

### 1. 安装依赖

```bash
# macOS
brew install node ffmpeg

# 验证
node -v
ffmpeg -version
```

### 2. 选择并配置转录方案

询问用户选择哪种转录方案，将选择写入 `.env`：

```bash
# .env 中设置（二选一）
ASR_ENGINE=volcengine   # 火山引擎 API
ASR_ENGINE=whisper      # Whisper 本地模型
ASR_ENGINE=             # 留空 = 每次询问
```

#### 方案 A：火山引擎 API

API Key 获取指南：https://my.feishu.cn/wiki/Gh0MwxHePidsYfkIx7zcvJQynqc?from=from_copylink

```bash
echo "VOLCENGINE_API_KEY=your_key" >> .claude/skills/.env
echo "ASR_ENGINE=volcengine" >> .claude/skills/.env
```

#### 方案 B：Whisper 本地模型

```bash
# 安装 mlx-whisper（Apple Silicon 优化）
pip3 install mlx-whisper

# 首次运行时会自动下载模型（~1.5GB）到 ~/.cache/huggingface/
echo "ASR_ENGINE=whisper" >> .claude/skills/.env
```

检查是否已安装：

```bash
python3 -c "import mlx_whisper; print('✅ mlx-whisper 已安装')"
```

如果未安装，直接执行 `pip3 install mlx-whisper` 帮用户安装。

### 4. 配置默认输出目录

询问用户希望将剪辑后的视频输出到哪个目录，写入 `.env`：

```bash
# 示例：用户指定 ~/Videos/output
echo "DEFAULT_OUTPUT_DIR=/Users/xxx/Videos/output" >> .claude/skills/.env
```

如果用户没有特别要求，可以使用视频文件所在目录的 `output/` 子目录作为默认值。

### 5. 验证环境

```bash
# 检查 Node.js
node -v

# 检查 FFmpeg
ffmpeg -version

# 检查转录方案配置
grep ASR_ENGINE .claude/skills/.env

# 如果选了火山引擎，检查 API Key
grep VOLCENGINE .claude/skills/.env

# 如果选了 Whisper，检查安装
python3 -c "import mlx_whisper; print('✅ mlx-whisper OK')"
```

## 常见问题

### Q1: API Key 在哪获取？

火山引擎控制台 → 语音技术 → 语音识别 → API Key

### Q2: ffmpeg 命令找不到

```bash
which ffmpeg  # 应该输出路径
# 如果没有，重新安装：brew install ffmpeg
```

### Q3: 文件名含冒号报错

FFmpeg 命令需加 `file:` 前缀：

```bash
ffmpeg -i "file:2026:01:26 task.mp4" ...
```
