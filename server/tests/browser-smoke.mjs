// Run from PianoVal/server: node tests/browser-smoke.mjs /path/to/mono-pcm16.wav
// Uses a prerecorded virtual microphone; this is not an iPad accuracy test.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const fixture = process.argv[2];
if (!fixture) throw new Error('Pass a mono PCM16 WAV for Chromium virtual microphone capture');
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${resolve(fixture)}`],
});
try {
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1024, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const messages = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
    try { messages.push(JSON.parse(String(payload))); } catch { /* No binary server messages expected. */ }
  }));
  await page.goto(process.env.PIANOVAL_TEST_URL || 'http://localhost:8765/');
  await page.locator('[data-view="live"]').click();
  await page.locator('#start').click();
  await page.waitForFunction(() => document.querySelector('#error').textContent || document.querySelector('#notes').rows.length > 0, null, { timeout: 20000 });
  assert.equal(await page.locator('#error').textContent(), '');
  assert.ok(await page.locator('#notes tr').count() > 0);
  await page.locator('#stop').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('处理完成'), null, { timeout: 20000 });
  assert.equal(await page.locator('#error').textContent(), '');
  assert.deepEqual(errors, []);
  const complete = messages.find((message) => message.type === 'complete');
  assert.ok(complete.receivedPackets > 0);
  assert.ok(complete.noteCount > 0);
  assert.ok(messages.some((message) => message.type === 'notes' && message.tailPadded));
  await mkdir('test-evidence', { recursive: true });
  await page.screenshot({ path: 'test-evidence/browser-websocket.png', fullPage: true });
  await writeFile('test-evidence/browser-websocket.json', JSON.stringify({ errors, messages }, null, 2) + '\n');
  console.log(JSON.stringify({ status: await page.locator('#status').textContent(), errors, complete }, null, 2));
} finally {
  await browser.close();
}
