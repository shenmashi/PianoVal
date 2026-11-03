export interface ScoreNote { midi: number; beats: number }
export interface PlayedNote { midi: number; start: number; duration: number; cents: number }
export type NoteStatus = 'correct' | 'wrong' | 'missed' | 'extra'
export interface Comparison { status: NoteStatus; expectedIndex: number | null; actualIndex: number | null }

const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const steps: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
export const midiToName = (midi: number) => `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
export const midiToFrequency = (midi: number) => 440 * 2 ** ((midi - 69) / 12)

export function parseNotes(text: string): ScoreNote[] {
  const tokens = text.trim().split(/[\s,，;；]+/).filter(Boolean)
  if (!tokens.length) throw new Error('请至少输入一个音符，例如 C4 D4 E4。')
  if (tokens.length > 128) throw new Error('原型一次支持最多 128 个音符，请按乐句拆分。')
  return tokens.map(token => {
    const match = /^([A-Ga-g])([#b]?)([1-7])$/.exec(token)
    if (!match) throw new Error(`无法识别“${token}”，请使用 C4、F#4 或 Bb4 这样的格式。`)
    const midi = (Number(match[3]) + 1) * 12 + steps[match[1]!.toUpperCase()]! + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0)
    if (midi < 48 || midi > 84) throw new Error('当前单音原型支持 C3～C6，请先选择这个音域内的旋律。')
    return { midi, beats: 1 }
  })
}

export function parseMusicXml(xml: string): ScoreNote[] {
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  if (document.querySelector('parsererror')) throw new Error('MusicXML 文件格式有误。')
  if (document.documentElement.tagName !== 'score-partwise') throw new Error('请导入未压缩的 score-partwise 格式 MusicXML。')
  const part = document.querySelector('part')
  if (!part) throw new Error('文件中没有找到乐谱声部。')
  if (document.querySelectorAll('part').length > 1 || part.querySelector('chord, backup, transpose')) {
    throw new Error('这份乐谱包含多声部、和弦或移调。当前原型只接受单音旋律，请先导出独立旋律声部；双手评测见技术方案。')
  }
  let divisions = 1
  const notes: ScoreNote[] = []
  for (const measure of part.querySelectorAll('measure')) {
    divisions = Number(measure.querySelector('divisions')?.textContent || divisions)
    for (const note of measure.querySelectorAll('note')) {
      if (note.querySelector('rest, grace')) continue
      if (note.querySelector('tie, time-modification')) throw new Error('当前原型尚不解析延音线和连音，请先使用基础单音练习谱。')
      const step = note.querySelector('pitch > step')?.textContent || ''
      const octave = Number(note.querySelector('pitch > octave')?.textContent)
      const alter = Number(note.querySelector('pitch > alter')?.textContent || 0)
      if (steps[step] === undefined || !Number.isFinite(octave)) throw new Error('乐谱包含无法识别的音高。')
      const midi = (octave + 1) * 12 + steps[step]! + alter
      if (midi < 48 || midi > 84) throw new Error('这份旋律超出当前原型的 C3～C6 识别范围。')
      const beats = Number(note.querySelector('duration')?.textContent || divisions) / divisions
      if (!Number.isFinite(beats) || beats <= 0) throw new Error('乐谱中的时值格式不正确。')
      notes.push({ midi, beats })
    }
  }
  if (!notes.length || notes.length > 128) throw new Error('请导入包含 1～128 个音符的单音乐句。')
  return notes
}

/** Edit-distance alignment keeps an extra or missing note from shifting the entire report. */
export function alignNotes(expected: ScoreNote[], actual: PlayedNote[]): Comparison[] {
  const rows = expected.length + 1, cols = actual.length + 1
  const cost = Array.from({ length: rows }, () => new Float64Array(cols))
  for (let i = 0; i < rows; i++) cost[i]![0] = i
  for (let j = 0; j < cols; j++) cost[0]![j] = j
  for (let i = 1; i < rows; i++) for (let j = 1; j < cols; j++) {
    cost[i]![j] = Math.min(
      cost[i - 1]![j - 1]! + (expected[i - 1]!.midi === actual[j - 1]!.midi ? 0 : 1),
      cost[i - 1]![j]! + 1,
      cost[i]![j - 1]! + 1,
    )
  }
  const result: Comparison[] = []
  let i = expected.length, j = actual.length
  while (i || j) {
    if (i && j && cost[i]![j] === cost[i - 1]![j - 1]! + (expected[i - 1]!.midi === actual[j - 1]!.midi ? 0 : 1)) {
      result.push({ status: expected[i - 1]!.midi === actual[j - 1]!.midi ? 'correct' : 'wrong', expectedIndex: --i, actualIndex: --j })
    } else if (i && cost[i]![j] === cost[i - 1]![j]! + 1) {
      result.push({ status: 'missed', expectedIndex: --i, actualIndex: null })
    } else result.push({ status: 'extra', expectedIndex: null, actualIndex: --j })
  }
  return result.reverse()
}
