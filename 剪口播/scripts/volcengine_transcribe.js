#!/usr/bin/env node
/**
 * 火山引擎语音识别（异步模式）— 跨平台 Node.js 版本
 *
 * 用法: node volcengine_transcribe.js <audio_url>
 * 输出: volcengine_result.json
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const AUDIO_URL = process.argv[2];
if (!AUDIO_URL) {
  console.error('❌ 用法: node volcengine_transcribe.js <audio_url>');
  process.exit(1);
}

// 获取 API Key
const SCRIPT_DIR = __dirname;
const ENV_FILE = path.join(SCRIPT_DIR, '..', '..', '.env');

if (!fs.existsSync(ENV_FILE)) {
  console.error(`❌ 找不到 ${ENV_FILE}`);
  console.error('请创建 .env 并填入 VOLCENGINE_API_KEY');
  process.exit(1);
}

const envContent = fs.readFileSync(ENV_FILE, 'utf8');
const envConfig = {};
for (const rawLine of envContent.split('\n')) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) continue;
  const idx = line.indexOf('=');
  if (idx === -1) continue;
  const key = line.slice(0, idx).trim();
  const value = line.slice(idx + 1).replace(/\s+#.*$/, '').trim();
  envConfig[key] = value;
}
const API_KEY = envConfig.VOLCENGINE_API_KEY || '';

if (!API_KEY) {
  console.error('❌ .env 中未找到 VOLCENGINE_API_KEY');
  process.exit(1);
}

console.log('🎤 提交火山引擎转录任务...');
console.log(`音频 URL: ${AUDIO_URL}`);

// 读取热词词典
const DICT_FILE = path.join(SCRIPT_DIR, '..', '..', '字幕', '词典.txt');
let hotWords = [];
if (fs.existsSync(DICT_FILE)) {
  hotWords = fs.readFileSync(DICT_FILE, 'utf8')
    .split('\n')
    .map(w => w.trim())
    .filter(w => w.length > 0);
  console.log(`📖 加载热词: ${hotWords.length} 个`);
}

// 构建请求体
const requestBody = { url: AUDIO_URL };
if (hotWords.length > 0) {
  requestBody.hot_words = hotWords.map(w => ({ word: w }));
}

// HTTP 请求封装
function request(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  // 步骤1: 提交任务
  const submitUrl = 'https://openspeech.bytedance.com/api/v1/vc/submit?language=zh-CN&use_itn=True&use_capitalize=True&max_lines=1&words_per_line=15';
  const headers = {
    'Accept': '*/*',
    'x-api-key': API_KEY,
    'Connection': 'keep-alive',
    'Content-Type': 'application/json',
  };

  const submitResponse = await request('POST', submitUrl, headers, JSON.stringify(requestBody));
  let submitData;
  try {
    submitData = JSON.parse(submitResponse);
  } catch (e) {
    console.error('❌ 提交失败，响应:', submitResponse);
    process.exit(1);
  }

  const taskId = submitData.id;
  if (!taskId) {
    console.error('❌ 提交失败，响应:');
    console.error(submitResponse);
    process.exit(1);
  }

  console.log(`✅ 任务已提交，ID: ${taskId}`);
  console.log('⏳ 等待转录完成...');

  // 步骤2: 轮询结果
  const MAX_ATTEMPTS = 120;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await sleep(5000);

    const queryUrl = `https://openspeech.bytedance.com/api/v1/vc/query?id=${taskId}`;
    const queryResponse = await request('GET', queryUrl, {
      'Accept': '*/*',
      'x-api-key': API_KEY,
      'Connection': 'keep-alive',
    });

    let queryData;
    try {
      queryData = JSON.parse(queryResponse);
    } catch (e) {
      process.stdout.write('.');
      continue;
    }

    const code = queryData.code;

    if (code === 0) {
      // 成功
      fs.writeFileSync('volcengine_result.json', queryResponse);
      console.log('\n✅ 转录完成，已保存 volcengine_result.json');

      const utteranceCount = queryData.utterances ? queryData.utterances.length : 0;
      console.log(`📝 识别到 ${utteranceCount} 段语音`);
      process.exit(0);
    } else if (code === 1000) {
      // 处理中
      process.stdout.write('.');
    } else {
      // 错误
      console.error('\n❌ 转录失败，响应:');
      console.error(queryResponse);
      process.exit(1);
    }
  }

  console.error('\n❌ 超时，任务未完成');
  process.exit(1);
}

main().catch(err => {
  console.error('❌ 错误:', err.message);
  process.exit(1);
});
