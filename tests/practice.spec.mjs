import { test, expect } from '@playwright/test'

test('example recording is analysed and a real wrong note is highlighted', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: '体验示例录音', exact: true }).click()
  await expect(page.locator('.result-score')).toBeVisible()
  await expect(page.locator('.result-score>div')).toHaveText('88%')
  await expect(page.locator('.issue')).toHaveCount(1)
  await expect(page.locator('.issue')).toContainText('应弹 G4，识别到 G#4')
  await expect(page.locator('.score-note.wrong')).toHaveCount(1)
  await expect(page.locator('.result-source')).toHaveText('示例音频评测')
  expect(await page.locator('audio').evaluate(element => element.src.startsWith('blob:'))).toBe(true)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出报告 ↗' }).click()
  expect((await download).suggestedFilename()).toMatch(/PianoVal-report-.*\.json/)
  expect(errors).toEqual([])
})

test('native getUserMedia and MediaRecorder capture the virtual microphone, score and release it', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await original(constraints); window.testMicrophoneTracks = stream.getTracks(); return stream
    }
  })
  await page.goto('/')
  await page.getByRole('button', { name: '● 开始录音', exact: true }).click()
  await expect(page.getByRole('button', { name: '■ 结束并评测', exact: true })).toBeVisible()
  await expect.poll(() => page.locator('.pitch-monitor>div:last-child strong').innerText(), { timeout: 12000 }).toMatch(/8/)
  await page.getByRole('button', { name: '■ 结束并评测', exact: true }).click()
  await expect(page.locator('.result-source')).toHaveText('本次麦克风录音')
  await expect(page.locator('.result-score>div')).toHaveText('100%')
  await expect.poll(() => page.locator('audio').evaluate(element => element.readyState)).toBeGreaterThanOrEqual(1)
  expect(await page.locator('audio').evaluate(element => element.duration)).toBeGreaterThan(3)
  expect(await page.evaluate(() => window.testMicrophoneTracks.every(track => track.readyState === 'ended'))).toBe(true)
  expect(errors).toEqual([])
})

test('permission denial and an unanswered permission prompt can both be exited', async ({ page }) => {
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError') } })
  await page.goto('/')
  await page.getByRole('button', { name: '● 开始录音', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('麦克风权限未开启')
  await expect(page.getByRole('button', { name: '● 开始录音', exact: true })).toBeEnabled()
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => new Promise(() => {}) })
  await page.getByRole('button', { name: '● 开始录音', exact: true }).click()
  await page.getByRole('button', { name: '■ 取消授权等待', exact: true }).click()
  await expect(page.getByRole('button', { name: '● 开始录音', exact: true })).toBeEnabled()
})

test('score editing and MusicXML importing reject unsupported polyphony', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '编辑音符', exact: true }).click()
  await page.getByLabel('输入参考音符').fill('C4 H4')
  await page.getByRole('button', { name: '应用旋律', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('无法识别')
  await page.getByLabel('输入参考音符').fill('C4 D4 E4')
  await page.getByRole('button', { name: '应用旋律', exact: true }).click()
  await expect(page.locator('.score-note')).toHaveCount(3)
  const xml = '<score-partwise><part id="P1"><measure><attributes><divisions>1</divisions></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note></measure></part></score-partwise>'
  await page.locator('input[type=file]').setInputFiles({ name: 'test.musicxml', mimeType: 'application/xml', buffer: Buffer.from(xml) })
  await expect(page.locator('.score-note')).toHaveCount(1)
  await page.locator('input[type=file]').setInputFiles({ name: 'chords.musicxml', mimeType: 'application/xml', buffer: Buffer.from(xml.replace('<pitch>', '<chord/><pitch>')) })
  await expect(page.getByRole('alert')).toContainText('包含多声部、和弦或移调')
  await expect(page.locator('.score-note')).toHaveCount(1)
})

for (const viewport of [{ width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
  test(`practice controls fit the ${viewport.width}×${viewport.height} viewport`, async ({ page }) => {
    await page.setViewportSize(viewport); await page.goto('/')
    await expect(page.getByRole('button', { name: '● 开始录音', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: `test-evidence/practice-${viewport.width}.png`, fullPage: true })
  })
}
