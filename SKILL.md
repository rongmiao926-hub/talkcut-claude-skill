---
name: videocut
description: |
  视频剪辑 Agent，专为口播视频设计

  功能：
  - 语义理解：AI 逐句分析，识别重说/纠正/卡顿
  - 静音检测：自动标记过长静音段
  - 重复句检测：删除重复内容，保留最佳表达
  - 文案生成：基于保留内容自动生成视频介绍草稿
  - 字幕生成：Whisper 转录 + 词典纠错
  - 自更新：记住用户偏好，越用越准

  触发场景：
  - 用户说"/videocut:install"
  - 用户说"/videocut:cut [视频文件]"
  - 用户说"/videocut:subtitle [视频文件]"
  - 用户说"/videocut:update"
---

# Videocut 视频剪辑

用 AI 辅助剪辑口播视频，自动识别并处理静音、口误、重复等问题。

## 快速开始

### 1. 安装（首次使用）

```
/videocut:install
```

会自动检查并安装：Python、FFmpeg、FunASR、Whisper 模型

### 2. 剪辑口播视频

```
/videocut:cut 视频.mp4
```

流程：
1. 提取音频 → 火山引擎转录（字级别时间戳）
2. AI 审核：静音/口误/重复/语气词
3. 生成审核网页 + 视频介绍草稿 → 浏览器打开
4. 人工确认 → FFmpeg 自动剪辑

### 3. 生成字幕

```
/videocut:subtitle 视频.mp4
```

流程：
1. Whisper 转录
2. 词典纠错（自定义术语）
3. 人工确认
4. 烧录字幕到视频

### 4. 自更新

```
/videocut:update
```

告诉 AI 你的偏好，它会记住：
- "静音阈值改成 1 秒"
- "保留适量嗯作为过渡"

## 子技能

| 子技能 | 功能 | 说明 |
|--------|------|------|
| install | 环境准备 | 检查并安装依赖 |
| cut | 转录 + AI 审核 + 剪辑 | 核心功能 |
| subtitle | 生成字幕 | 带词典纠错 |
| update | 记录偏好 | 自我进化 |

## 配置

首次使用前需要：
1. 复制 `.env.example` 为 `.env`
2. 填入火山引擎 API Key

申请地址：https://console.volcengine.com/

## 依赖

- Node.js 18+
- FFmpeg
- Python 3.8+
- 火山引擎 API Key
