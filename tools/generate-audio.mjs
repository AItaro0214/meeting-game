#!/usr/bin/env node
// 会議探偵 音声素材の生成: ナレーション (Gemini TTS + 書き起こし検証) とジングル (Lyria)。
// 使い方:
//   node tools/generate-audio.mjs                  # 未生成分だけ生成 + manifest 更新
//   node tools/generate-audio.mjs --only <id>      # 特定の行 / ジングルだけ
//   node tools/generate-audio.mjs --force          # 既存ファイルも作り直し
//   node tools/generate-audio.mjs --manifest-only  # 生成せず manifest.json だけ作り直し
// 環境変数 GeminiAPI が必要。キーは出力もファイルにも書かない。
// 効果音は tools/make_sfx.py で別途生成する (manifest はこのスクリプトが sfx も含めて書く)。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const AUDIO_DIR = path.join(ROOT, 'public', 'assets', 'audio');
const VOICE_DIR = path.join(AUDIO_DIR, 'voice');
const MUSIC_DIR = path.join(AUDIO_DIR, 'music');
const SFX_DIR = path.join(AUDIO_DIR, 'sfx');
const LOG_DIR = path.join(__dirname, 'logs');
const TMP = path.join(__dirname, '.tmp');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'voice-lines.json'), 'utf8'));

const API_KEY = process.env.GeminiAPI;
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_RETRY = 6;          // 503 / 429 などの再試行回数
const MAX_REGEN = 3;          // 書き起こし検証に落ちた行の再生成回数
const SIMILARITY_MIN = 0.8;   // 句読点等を除いた文字列の一致率しきい値
const CONCURRENCY = 2;

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const MANIFEST_ONLY = args.includes('--manifest-only');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

// 同時実行数を制限する簡易プール
function makePool(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
const pool = makePool(CONCURRENCY);

// ---- Gemini API ------------------------------------------------------------
async function callGemini(model, body) {
  if (!API_KEY) throw new Error('環境変数 GeminiAPI が未設定です');
  let delay = 3000;
  for (let attempt = 1; attempt <= MAX_RETRY + 1; attempt++) {
    let res;
    let text;
    try {
      res = await fetch(`${API_BASE}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
      });
      text = await res.text();
    } catch (e) {
      if (attempt > MAX_RETRY) throw new Error(`${model}: 通信エラー (${e.message})`);
      log(`  ${model}: 通信エラー、${delay / 1000}s 後に再試行 (${attempt}/${MAX_RETRY})`);
      await sleep(delay); delay = Math.min(delay * 2, 60_000);
      continue;
    }
    if (res.ok) return JSON.parse(text);
    const retryable = [429, 500, 502, 503, 504].includes(res.status);
    if (retryable && attempt <= MAX_RETRY) {
      log(`  ${model}: HTTP ${res.status}、${delay / 1000}s 後に再試行 (${attempt}/${MAX_RETRY})`);
      await sleep(delay); delay = Math.min(delay * 2, 60_000);
      continue;
    }
    throw new Error(`${model}: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  throw new Error(`${model}: リトライ上限に到達`);
}

function findInlineAudio(resp) {
  const parts = resp?.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    const d = p.inlineData ?? p.inline_data;
    if (d?.data) return { mime: d.mimeType ?? d.mime_type ?? '', data: Buffer.from(d.data, 'base64') };
  }
  return null;
}

function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // PCM チャンク長
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(1, 22);           // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (16bit mono)
  header.writeUInt16LE(2, 32);           // block align
  header.writeUInt16LE(16, 34);          // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// ---- ffmpeg / ffprobe -------------------------------------------------------
function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} 失敗: ${(r.stderr || '').split('\n').slice(-5).join('\n')}`);
  return r;
}

function duration(file) {
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Math.round(parseFloat(r.stdout) * 100) / 100;
}

// silencedetect の結果 (stderr) から無音区間を取り出す
function silences(file, { seconds, noise, minDur }) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, ...(seconds ? ['-t', String(seconds)] : []),
    '-af', `silencedetect=noise=${noise}:d=${minDur}`, '-f', 'null', '-'], { encoding: 'utf8' });
  const out = [];
  let cur = null;
  for (const line of (r.stderr || '').split('\n')) {
    const s = line.match(/silence_start: ([\d.]+)/);
    const e = line.match(/silence_end: ([\d.]+)/);
    if (s) cur = { start: parseFloat(s[1]), end: null };
    if (e && cur) { cur.end = parseFloat(e[1]); out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}

// ---- ナレーション -----------------------------------------------------------
function buildTtsPrompt(style, text) {
  const t = CONFIG.tts;
  return `# AUDIO PROFILE: ${t.persona}
${t.personaDescription}

### DIRECTOR'S NOTES
Style: ${style}

#### TRANSCRIPT
${text}`;
}

async function synthesize(line) {
  const t = CONFIG.tts;
  const body = {
    contents: [{ parts: [{ text: buildTtsPrompt(line.style, line.text) }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        languageCode: t.languageCode,
        voiceConfig: { prebuiltVoiceConfig: { voiceName: t.voiceName } },
      },
    },
  };
  const audio = findInlineAudio(await callGemini(t.model, body));
  if (!audio) throw new Error('TTS の応答に音声がありません');
  if (/l16|pcm/i.test(audio.mime)) {
    const rate = parseInt(audio.mime.match(/rate=(\d+)/)?.[1] ?? String(t.sampleRate), 10);
    return pcmToWav(audio.data, rate);
  }
  return audio.data; // audio/wav など、そのまま ffmpeg に渡す
}

// 無音カット + 末尾 0.15 秒の余韻 → mono 64k mp3
function trimVoice(inFile, outFile) {
  run('ffmpeg', ['-y', '-v', 'error', '-i', inFile, '-af',
    'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,' +
    'areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,areverse,' +
    'apad=pad_dur=0.15',
    '-ac', '1', '-b:a', '64k', outFile]);
}

async function transcribe(mp3File) {
  const t = CONFIG.tts;
  const body = {
    contents: [{ parts: [
      { inlineData: { mimeType: 'audio/mpeg', data: fs.readFileSync(mp3File).toString('base64') } },
      { text: t.verifyPrompt },
    ] }],
    generationConfig: { temperature: 0 },
  };
  const resp = await callGemini(t.verifyModel, body);
  return (resp?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
}

// 比較用の正規化: 全角半角を揃え、句読点・記号・空白を落とす
// 表記ゆれ (漢字と仮名の読み違い) は同じ読みとして扱う
const READING_VARIANTS = [['流石', 'さすが']];

function normalizeJa(s) {
  let t = s;
  for (const [from, to] of READING_VARIANTS) t = t.split(from).join(to);
  return t.normalize('NFKC').replace(/[\s。、！？!?.,…‥・「」『』"'“”\-―〜~()（）]/g, '');
}

function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function verify(expected, transcript) {
  const reasons = [];
  if (/[A-Za-z]/.test(transcript)) reasons.push('英字が混入');
  if (/AUDIO|PROFILE|DIRECTOR|TRANSCRIPT|Style|STYLE/i.test(transcript)) reasons.push('指示文が混入');
  const a = normalizeJa(expected);
  const b = normalizeJa(transcript);
  const sim = a.length || b.length ? 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1) : 0;
  if (sim < SIMILARITY_MIN) reasons.push(`一致率 ${sim.toFixed(2)} (しきい値 ${SIMILARITY_MIN})`);
  return { ok: reasons.length === 0, similarity: Math.round(sim * 1000) / 1000, reasons };
}

function appendLog(entry) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, 'voice-transcripts.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

async function processVoice(line) {
  const out = path.join(VOICE_DIR, `${line.id}.mp3`);
  if (!FORCE && fs.existsSync(out)) { log(`skip ${line.id} (生成済み)`); return { id: line.id, status: 'skipped' }; }
  log(`voice ${line.id}: ${line.text}`);
  let lastFile = null;
  let last = null;
  for (let regen = 0; regen <= MAX_REGEN; regen++) {
    const raw = await synthesize(line);
    const rawFile = path.join(TMP, `${line.id}_${regen}.raw`);
    const trimmed = path.join(TMP, `${line.id}_${regen}.mp3`);
    fs.writeFileSync(rawFile, raw);
    trimVoice(rawFile, trimmed);
    const transcript = await transcribe(trimmed);
    const v = verify(line.text, transcript);
    appendLog({ id: line.id, attempt: regen + 1, expected: line.text, transcript, ...v });
    log(`  書き起こし(${regen + 1}回目): ${transcript}  -> ${v.ok ? 'OK' : 'NG: ' + v.reasons.join(', ')}`);
    lastFile = trimmed;
    last = { regenerated: regen, transcript, ...v };
    if (v.ok) break;
    if (regen === MAX_REGEN) break;
  }
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  fs.copyFileSync(lastFile, out);
  const status = last.ok ? 'ok' : 'UNVERIFIED';
  return { id: line.id, status, regenerated: last.regenerated, transcript: last.transcript, reasons: last.reasons };
}

// ---- ジングル ---------------------------------------------------------------
async function processMusic(m) {
  const out = path.join(MUSIC_DIR, `${m.id}.mp3`);
  if (!FORCE && fs.existsSync(out)) { log(`skip music ${m.id} (生成済み)`); return { id: m.id, status: 'skipped' }; }
  log(`music ${m.id}: Lyria 生成中`);
  const resp = await callGemini('lyria-3-clip-preview', { contents: [{ parts: [{ text: m.prompt }] }] });
  const audio = findInlineAudio(resp);
  if (!audio) throw new Error(`${m.id}: 応答に音声がありません`);
  fs.mkdirSync(TMP, { recursive: true });
  const ext = /wav/i.test(audio.mime) ? 'wav' : 'mp3';
  const rawFile = path.join(TMP, `music_${m.id}.${ext}`);
  fs.writeFileSync(rawFile, audio.data);

  // 冒頭の無音をずらす (先頭 0 秒から無音が始まり、途中で鳴り出す場合)
  const lead = silences(rawFile, { seconds: 3, noise: '-45dB', minDur: 0.1 })
    .find((s) => s.start < 0.05 && s.end !== null);
  const offset = lead ? Math.max(0, lead.end - 0.02) : 0;
  if (lead) log(`  冒頭 ${lead.end.toFixed(2)} 秒まで無音のため、その分ずらして切り出し`);
  if (silences(rawFile, { seconds: 3, noise: '-45dB', minDur: 0.1 }).some((s) => s.end === null && s.start < 0.05)) {
    throw new Error(`${m.id}: 冒頭3秒がほぼ無音です`);
  }

  // 冒頭切り出し、ラウドネス -16 LUFS 付近、末尾 0.8 秒フェードアウト
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  run('ffmpeg', ['-y', '-v', 'error', '-ss', offset.toFixed(3), '-t', String(m.seconds), '-i', rawFile,
    '-af', `loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=out:st=${(m.seconds - 0.8).toFixed(2)}:d=0.8`,
    '-b:a', '128k', out]);

  // 検証: 出力の頭 0.5 秒が無音でないこと
  const headSil = silences(out, { seconds: 0.5, noise: '-50dB', minDur: 0.2 })
    .some((s) => s.start < 0.05 && (s.end === null || s.end >= 0.45));
  const dur = duration(out);
  log(`  ${m.id}: ${dur} 秒, 冒頭無音=${headSil ? 'あり(NG)' : 'なし(OK)'}`);
  return { id: m.id, status: headSil ? 'HEAD_SILENT' : 'ok', duration: dur, headSilent: headSil, offset };
}

// ---- manifest ---------------------------------------------------------------
function buildManifest() {
  const rel = (p) => path.relative(path.join(ROOT, 'public'), p).split(path.sep).join('/');
  const exists = (p) => fs.existsSync(p);
  const voice = {};
  for (const cat of Object.keys(CONFIG.lines)) {
    voice[cat] = CONFIG.lines[cat].map((l, i) => ({ id: `${cat}_${i + 1}`, file: rel(path.join(VOICE_DIR, `${cat}_${i + 1}.mp3`)), text: l.text, _f: path.join(VOICE_DIR, `${cat}_${i + 1}.mp3`) }))
      .filter((v) => exists(v._f))
      .map(({ _f, ...v }) => ({ ...v, duration: duration(_f) }));
  }
  const music = {};
  for (const m of CONFIG.music) {
    const f = path.join(MUSIC_DIR, `${m.id}.mp3`);
    if (exists(f)) music[m.id] = rel(f);
  }
  const sfxIds = { crack: ['crack_1', 'crack_2'], shatter: ['shatter_1', 'shatter_2', 'shatter_3'], stamp: ['stamp'], thud: ['thud'] };
  const sfx = {};
  for (const [k, ids] of Object.entries(sfxIds)) {
    sfx[k] = ids.map((id) => path.join(SFX_DIR, `${id}.mp3`)).filter(exists).map(rel);
  }
  const manifest = { version: 1, voice, music, sfx };
  fs.writeFileSync(path.join(AUDIO_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  log(`manifest.json を書き出しました (voice ${Object.values(voice).reduce((n, a) => n + a.length, 0)} 行 / music ${Object.keys(music).length} / sfx ${Object.values(sfx).reduce((n, a) => n + a.length, 0)})`);
}

// ---- main -------------------------------------------------------------------
async function main() {
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  if (!MANIFEST_ONLY) {
    const jobs = [];
    for (const [cat, lines] of Object.entries(CONFIG.lines)) {
      lines.forEach((l, i) => {
        const id = `${cat}_${i + 1}`;
        if (ONLY && ONLY !== id) return;
        jobs.push(pool(() => processVoice({ ...l, id })));
      });
    }
    for (const m of CONFIG.music) {
      if (ONLY && ONLY !== m.id) continue;
      jobs.push(pool(() => processMusic(m)));
    }
    const results = await Promise.allSettled(jobs);
    const summary = results.map((r) => (r.status === 'fulfilled' ? r.value : { status: 'ERROR', error: r.reason?.message }));
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOG_DIR, 'generate-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
    for (const s of summary) if (s.status !== 'ok' && s.status !== 'skipped') log(`!! ${s.id ?? ''} ${s.status} ${s.error ?? s.reasons?.join(', ') ?? ''}`);
  }
  buildManifest();
  fs.rmSync(TMP, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
