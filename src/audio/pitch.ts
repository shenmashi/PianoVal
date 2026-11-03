export interface Pitch { frequency: number; midi: number; cents: number; confidence: number; rms: number }

/** YIN difference/normalized difference. A monophonic estimator, not a chord transcriber. */
export function detectPitch(samples: Float32Array, sampleRate: number): Pitch | null {
  let energy = 0, mean = 0
  for (const value of samples) { energy += value * value; mean += value }
  const rms = Math.sqrt(energy / samples.length)
  if (!Number.isFinite(rms) || rms < 0.008 || sampleRate <= 0) return null
  mean /= samples.length
  const maxTau = Math.min(Math.floor(sampleRate / 110), Math.floor(samples.length / 2))
  const minTau = Math.max(2, Math.floor(sampleRate / 1200))
  const difference = new Float32Array(maxTau + 1)
  const normalized = new Float32Array(maxTau + 1)
  const length = samples.length - maxTau
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0
    for (let index = 0; index < length; index++) {
      const delta = (samples[index]! - mean) - (samples[index + tau]! - mean)
      sum += delta * delta
    }
    difference[tau] = sum
  }
  let runningSum = 0
  normalized[0] = 1
  for (let tau = 1; tau <= maxTau; tau++) {
    runningSum += difference[tau]!
    normalized[tau] = runningSum ? difference[tau]! * tau / runningSum : 1
  }
  for (let tau = minTau; tau < maxTau - 1; tau++) {
    if (normalized[tau]! >= 0.14) continue
    while (tau + 1 < maxTau && normalized[tau + 1]! < normalized[tau]!) tau++
    const left = normalized[tau - 1]!, mid = normalized[tau]!, right = normalized[tau + 1]!
    const denominator = 2 * (2 * mid - right - left)
    const period = tau + (denominator ? (right - left) / denominator : 0)
    const frequency = sampleRate / period
    const preciseMidi = 69 + 12 * Math.log2(frequency / 440)
    const midi = Math.round(preciseMidi)
    if (midi < 48 || midi > 84) return null
    return { frequency, midi, cents: (preciseMidi - midi) * 100, confidence: 1 - mid, rms }
  }
  return null
}
