import { describe, expect, it } from 'vitest'
import type { ModelOption } from '@gearmod/contracts'
import { splitModels } from './modelFamilies'

const models = (...labels: string[]): ModelOption[] => labels.map((label) => ({ id: label.toLowerCase().replace(/\W+/g, '-'), label, description: '', efforts: [], recommendedFor: [], defaultEffort: null }))
const labels = (list: ModelOption[]): string[] => list.map((item) => item.label)

describe('model menu: newest of each family first, older ones in "More models"', () => {
  it('Claude account list', () => {
    const { main, older } = splitModels(models('Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5', 'Fable 5.1', 'Haiku 4.5', 'Sonnet 5', 'Opus 5', 'Fable 5', 'Opus 4.8', 'Opus 4.7', 'Opus 4.6', 'Sonnet 4.6'))
    expect(labels(main)).toEqual(['Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5'])
    expect(labels(older)).toEqual(['Fable 5.1', 'Haiku 4.5', 'Sonnet 5', 'Opus 5', 'Fable 5', 'Opus 4.8', 'Opus 4.7', 'Opus 4.6', 'Sonnet 4.6'])
  })

  it('Codex: variants are families of their own; 5.10 is newer than 5.9', () => {
    const { main, older } = splitModels(models('GPT-5.9', 'GPT-5.10', 'GPT-5.9-mini', 'GPT-5.10 Codex', 'GPT-5.9 Codex'))
    expect(labels(main)).toEqual(['GPT-5.10', 'GPT-5.9-mini', 'GPT-5.10 Codex'])
    expect(labels(older)).toEqual(['GPT-5.9', 'GPT-5.9 Codex'])
  })

  it('Antigravity: Auto and single models stay on the list', () => {
    const { main, older } = splitModels(models('Auto', 'Gemini 3.8 Flash', 'Gemini 3.5 Flash', 'Claude Sonnet 4.6 (Thinking)', 'GPT-OSS 120B (Medium)'))
    expect(labels(main)).toEqual(['Auto', 'Gemini 3.8 Flash', 'Claude Sonnet 4.6 (Thinking)', 'GPT-OSS 120B (Medium)'])
    expect(labels(older)).toEqual(['Gemini 3.5 Flash'])
  })
})
