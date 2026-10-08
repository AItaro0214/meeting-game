// 会議探偵 画像セット生成スクリプト
// 使い方:
//   node tools/generate-assets.mjs                  未生成のジョブを全部生成（同時実行 3）
//   node tools/generate-assets.mjs --only <jobId>   特定ジョブだけ生成（生成済みならスキップ）
//   node tools/generate-assets.mjs --only <jobId> --force   上書き再生成
//   --force 単独: 全ジョブを上書き再生成
// 環境変数 "GPT API" に OpenAI API キーが必要（値はログに出さない）。

import { readFile, writeFile, rename, stat, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = path.join(HERE, "asset-spec.json");
const RAW_DIR = path.join(HERE, "raw");
const ENDPOINT = "https://api.openai.com/v1/images/generations";
const PRIMARY_MODEL = "gpt-image-2.5-sunburst";
const FALLBACK_MODEL = "gpt-image-2.5-flare";
const CONCURRENCY = 3;
const RETRIES = 2;                 // 主モデルでの再試行回数
const REQUEST_TIMEOUT_MS = 300_000;

const args = process.argv.slice(2);
const force = args.includes("--force");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
if (onlyIdx >= 0 && !only) {
  console.error("--only には jobId を指定してください");
  process.exit(1);
}

const apiKey = process.env["GPT API"];
if (!apiKey) {
  console.error('環境変数 "GPT API" が設定されていません');
  process.exit(1);
}

const ts = () => new Date().toLocaleTimeString("ja-JP", { hour12: false });
const log = (msg) => console.log(`[${ts()}] ${msg}`);

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function requestImage(job, model) {
  const body = {
    model,
    prompt: job.prompt,
    size: job.size,
    quality: job.quality,
    background: job.background,
    output_format: "png",
    n: 1,
  };
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  const json = await res.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error("レスポンスに data[0].b64_json がありません");
  return Buffer.from(b64, "base64");
}

// 主モデルで RETRIES 回リトライ → 失敗したらフォールバックモデルで 1 回
async function generateWithFallback(job) {
  const attempts = [];
  for (let i = 0; i <= RETRIES; i++) attempts.push(PRIMARY_MODEL);
  attempts.push(FALLBACK_MODEL);

  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const model = attempts[i];
    if (i === RETRIES + 1) log(`  ${job.jobId}: フォールバックモデル ${FALLBACK_MODEL} に切り替え`);
    const started = Date.now();
    try {
      const buf = await requestImage(job, model);
      log(`  ${job.jobId}: 完了 (${model}, ${Math.round((Date.now() - started) / 1000)}s)`);
      return { buf, model };
    } catch (err) {
      lastErr = err;
      log(`  ${job.jobId}: 失敗 (${model}, 試行${i + 1}/${attempts.length}): ${err.message}`);
      if (i < attempts.length - 1) await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function runJob(job) {
  const outPath = path.join(RAW_DIR, `${job.jobId}.png`);
  const tmpPath = `${outPath}.tmp`;
  const { buf, model } = await generateWithFallback(job);
  await writeFile(tmpPath, buf);
  await rename(tmpPath, outPath);
  return model;
}

async function main() {
  const spec = JSON.parse(await readFile(SPEC_PATH, "utf8"));
  await mkdir(RAW_DIR, { recursive: true });

  let jobs = spec.jobs;
  if (only) {
    jobs = jobs.filter((j) => j.jobId === only);
    if (jobs.length === 0) {
      log(`jobId が見つかりません: ${only}`);
      process.exit(1);
    }
  }

  const todo = [];
  for (const job of jobs) {
    const outPath = path.join(RAW_DIR, `${job.jobId}.png`);
    const done = await exists(outPath);
    // --only 指定時は、生成済みでも --force がなければスキップ
    // --force 単独（--only なし）は全ジョブを上書き
    if (done && !force) {
      log(`スキップ（生成済み）: ${job.jobId}`);
      continue;
    }
    todo.push(job);
  }
  log(`対象 ${todo.length} / 全 ${jobs.length} ジョブを生成します（同時実行 ${CONCURRENCY}）`);

  let next = 0, ok = 0, ng = 0;
  const failed = [];
  async function worker() {
    while (next < todo.length) {
      const job = todo[next++];
      log(`開始: ${job.jobId} (${job.kind})`);
      try {
        await runJob(job);
        ok++;
      } catch (err) {
        ng++;
        failed.push(job.jobId);
        log(`最終失敗: ${job.jobId}: ${err.message}`);
      }
      log(`進捗: 成功 ${ok} / 失敗 ${ng} / 残り ${todo.length - ok - ng}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));

  log(`終了: 成功 ${ok} / 失敗 ${ng}`);
  if (failed.length) {
    log(`失敗ジョブ: ${failed.join(", ")}（再実行で未生成分のみ再試行されます）`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`致命的エラー: ${err.message}`);
  process.exit(1);
});
