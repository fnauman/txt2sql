/**
 * Records an MP4 (and optionally GIF) demo of the text-to-sql web UI by driving
 * it with a headless browser. No screen recording, no manual clicking — the
 * script types each question, runs it, waits for the streaming pipeline to
 * finish, and lingers on the result so the chart/table are visible.
 *
 * Prereqs (one time, not part of the app's dependencies):
 *   npm i -D playwright && npx playwright install chromium
 *   ffmpeg must be on PATH (used to encode the mp4/gif).
 *
 * Usage:
 *   1. Start the app with a working .env (OPENAI_API_KEY + DB_*):  npm run web:dev
 *   2. node apps/web/scripts/record-web-demo.mjs
 *
 * Env overrides:
 *   BASE_URL    default http://127.0.0.1:5173 (the vite dev server)
 *   OUT_DIR     default <repo>/media
 *   WIDTH/HEIGHT  default 1280x800
 *   QUERIES     JSON array of questions to demo
 *   GIF=1       also produce media/demo.gif (high-quality palette)
 *   TYPE_DELAY  ms per typed char (default 40)
 *   READ_PAUSE  ms to linger on each result (default 3500)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error(
    'Playwright is not installed. Run:\n  npm i -D playwright && npx playwright install chromium',
  );
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5173';
const OUT_DIR = path.resolve(process.env.OUT_DIR || path.join(repoRoot, 'media'));
const WIDTH = Number(process.env.WIDTH || 1280);
const HEIGHT = Number(process.env.HEIGHT || 800);
const TYPE_DELAY = Number(process.env.TYPE_DELAY || 40);
const READ_PAUSE = Number(process.env.READ_PAUSE || 3500);
const MAKE_GIF = process.env.GIF === '1';
const QUERIES = process.env.QUERIES
  ? JSON.parse(process.env.QUERIES)
  : [
      'Monthly sales trend for sparkling water this year',
      'Top customers by invoice value',
      'Show outstanding balance by customer',
    ];

const videoDir = path.join(OUT_DIR, 'video');
fs.rmSync(videoDir, { recursive: true, force: true });
fs.mkdirSync(videoDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 2, // crisper text in the recording
  recordVideo: { dir: videoDir, size: { width: WIDTH, height: HEIGHT } },
});
const page = await context.newPage();

console.log(`→ opening ${BASE_URL}`);
await page.goto(BASE_URL, { waitUntil: 'networkidle' });
const textarea = page.locator('form.query-composer textarea');
await textarea.waitFor({ state: 'visible', timeout: 15000 });
await page.waitForTimeout(1200); // hold on the empty console for a beat

const runBtn = page.locator('button.primary-button');

for (const q of QUERIES) {
  console.log(`→ query: ${q}`);
  await textarea.click();
  await textarea.fill('');
  await textarea.pressSequentially(q, { delay: TYPE_DELAY });
  await page.waitForTimeout(450);
  await runBtn.click();

  // loading started (Run button disabled) — ok if too fast to catch
  await page
    .waitForFunction(() => {
      const b = document.querySelector('button.primary-button');
      return b && b.disabled;
    }, { timeout: 8000 })
    .catch(() => {});
  // loading finished (Run button enabled again)
  await page.waitForFunction(() => {
    const b = document.querySelector('button.primary-button');
    return b && !b.disabled;
  }, { timeout: 90000 });

  // make sure results are on screen, then linger
  await page
    .locator('.result-main, .error-banner, .empty-state')
    .first()
    .waitFor({ timeout: 10000 })
    .catch(() => {});
  await page.waitForTimeout(800);
  await page.mouse.wheel(0, 520); // reveal chart/table
  await page.waitForTimeout(READ_PAUSE);
  await page.mouse.wheel(0, -520);
  await page.waitForTimeout(500);
}

await page.waitForTimeout(800);
await context.close(); // finalizes the webm
await browser.close();

const webm = fs.readdirSync(videoDir).find((f) => f.endsWith('.webm'));
if (!webm) throw new Error('no video produced');
const webmPath = path.join(videoDir, webm);
const mp4Path = path.join(OUT_DIR, 'demo.mp4');

console.log('→ encoding mp4');
const mp4 = spawnSync('ffmpeg', [
  '-y', '-loglevel', 'error', '-i', webmPath,
  '-vf', `scale=${WIDTH}:-2:flags=lanczos`,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', mp4Path,
], { stdio: 'inherit' });
if (mp4.status !== 0) throw new Error('ffmpeg mp4 failed');

if (MAKE_GIF) {
  console.log('→ encoding gif');
  const palette = path.join(videoDir, 'palette.png');
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4Path, '-vf',
    'fps=12,scale=800:-1:flags=lanczos,palettegen=stats_mode=diff', palette], { stdio: 'inherit' });
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4Path, '-i', palette, '-lavfi',
    'fps=12,scale=800:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3',
    path.join(OUT_DIR, 'demo.gif')], { stdio: 'inherit' });
}

// The raw .webm is an intermediate; drop it so only the encoded assets remain.
fs.rmSync(videoDir, { recursive: true, force: true });

console.log(`\n✓ done`);
console.log(`  ${mp4Path}`);
if (MAKE_GIF) console.log(`  ${path.join(OUT_DIR, 'demo.gif')}`);
