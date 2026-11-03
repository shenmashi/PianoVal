<script setup lang="ts">
import { computed } from 'vue'
import { midiToName } from '../music/notes'
import type { ScoreNote, Comparison } from '../music/notes'
const props = defineProps<{ notes: ScoreNote[]; comparisons: Comparison[] }>()
const rows = computed(() => Array.from({ length: Math.ceil(props.notes.length / 8) }, (_, i) => props.notes.slice(i * 8, i * 8 + 8)))
const status = (index: number) => props.comparisons.find(item => item.expectedIndex === index)?.status || 'pending'
const pitchY = (midi: number) => {
  const name = midiToName(midi)
  const step = ['C', 'D', 'E', 'F', 'G', 'A', 'B'].indexOf(name[0]!) + (Math.floor(midi / 12) - 1) * 7
  return 112 - (step - 30) * 10
}
const ledgers = (y: number) => {
  const result: number[] = []
  for (let line = 132; line <= y; line += 20) result.push(line)
  for (let line = 12; line >= y; line -= 20) result.push(line)
  return result
}
</script>

<template>
  <div class="score-staves" aria-label="参考音符乐谱">
    <svg v-for="(row, rowIndex) in rows" :key="rowIndex" viewBox="0 0 960 182" role="img" :aria-label="`第 ${rowIndex + 1} 行旋律`">
      <line v-for="line in 5" :key="line" x1="28" x2="932" :y1="12 + line * 20" :y2="12 + line * 20" class="staff-line" />
      <text x="32" y="122" class="treble">𝄞</text>
      <text x="99" y="70" class="time-signature">4</text><text x="99" y="103" class="time-signature">4</text>
      <text x="30" y="20" class="bar-number">{{ rowIndex * 2 + 1 }}</text>
      <line x1="527" x2="527" y1="32" y2="112" class="bar-line" /><line x1="932" x2="932" y1="32" y2="112" class="bar-line" />
      <g v-for="(note, i) in row" :key="i" :class="['score-note', status(rowIndex * 8 + i)]" :data-note-index="rowIndex * 8 + i">
        <rect :x="151 + i * 97" y="22" width="58" height="128" rx="18" class="note-highlight" />
        <line v-for="y in ledgers(pitchY(note.midi))" :key="y" :x1="162 + i * 97" :x2="198 + i * 97" :y1="y" :y2="y" class="ledger" />
        <text v-if="midiToName(note.midi).includes('#')" :x="154 + i * 97" :y="pitchY(note.midi) + 7" class="accidental">♯</text>
        <ellipse :cx="180 + i * 97" :cy="pitchY(note.midi)" rx="10" ry="6.5" :transform="`rotate(-18 ${180 + i * 97} ${pitchY(note.midi)})`" class="note-head" />
        <line :x1="189 + i * 97" :x2="189 + i * 97" :y1="pitchY(note.midi) - 2" :y2="pitchY(note.midi) - 39" class="note-stem" />
        <text :x="180 + i * 97" y="171" class="note-caption">{{ midiToName(note.midi) }}</text>
      </g>
    </svg>
  </div>
</template>
