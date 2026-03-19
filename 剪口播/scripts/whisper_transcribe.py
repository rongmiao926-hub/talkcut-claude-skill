#!/usr/bin/env python3
"""
Whisper 本地转录 → subtitles_words.json

用法: python3 whisper_transcribe.py <audio_file>
输出: subtitles_words.json（当前目录）

依赖: pip3 install mlx-whisper
模型: mlx-community/whisper-large-v3-turbo（首次运行自动下载，约 1.5GB）
"""

import sys
import json
import math

MODEL = "mlx-community/whisper-large-v3-turbo"

def transcribe(audio_path):
    """调用 mlx_whisper 转录，返回 segments with word timestamps."""
    import mlx_whisper
    print(f"🎙️  正在转录: {audio_path}")
    print(f"📦  模型: {MODEL}")
    result = mlx_whisper.transcribe(
        audio_path,
        path_or_hf_repo=MODEL,
        language="zh",
        word_timestamps=True,
        verbose=False,
    )
    return result


def to_subtitles_words(result):
    """将 whisper 结果转换为 subtitles_words.json 格式。

    Gap 检测逻辑与 generate_subtitles.js 保持一致：
    - >0.1s 插入 gap
    - >0.5s 按 1s 拆分
    """
    # 提取所有字级别时间戳
    all_words = []
    for segment in result.get("segments", []):
        for w in segment.get("words", []):
            text = w["word"].strip()
            if not text:
                continue
            all_words.append({
                "text": text,
                "start": round(w["start"], 2),
                "end": round(w["end"], 2),
            })

    if not all_words:
        print("⚠️  未检测到任何文字")
        return []

    print(f"原始字数: {len(all_words)}")

    # 添加 gap 标记
    words_with_gaps = []
    last_end = 0.0

    for word in all_words:
        gap_duration = word["start"] - last_end

        if gap_duration > 0.1:
            if gap_duration > 0.5:
                # 大于 0.5s 的静音按 1s 拆分
                gap_start = last_end
                while gap_start < word["start"]:
                    gap_end = min(gap_start + 1, word["start"])
                    words_with_gaps.append({
                        "text": "",
                        "start": round(gap_start, 2),
                        "end": round(gap_end, 2),
                        "isGap": True,
                    })
                    gap_start = gap_end
            else:
                words_with_gaps.append({
                    "text": "",
                    "start": round(last_end, 2),
                    "end": round(word["start"], 2),
                    "isGap": True,
                })

        words_with_gaps.append({
            "text": word["text"],
            "start": word["start"],
            "end": word["end"],
            "isGap": False,
        })
        last_end = word["end"]

    gaps = [w for w in words_with_gaps if w["isGap"]]
    print(f"总元素数: {len(words_with_gaps)}")
    print(f"空白段数: {len(gaps)}")

    return words_with_gaps


def main():
    if len(sys.argv) < 2:
        print("用法: python3 whisper_transcribe.py <audio_file>")
        sys.exit(1)

    audio_path = sys.argv[1]

    result = transcribe(audio_path)
    words = to_subtitles_words(result)

    output_file = "subtitles_words.json"
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(words, f, ensure_ascii=False, indent=2)

    print(f"✅ 已保存 {output_file}")


if __name__ == "__main__":
    main()
