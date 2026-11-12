import { describe, expect, it } from 'vitest'
import { projectStatus } from './sidebarStatus'

describe('status do projeto', () => {
  it.each([
    [{ running: 4, finished: 2, waiting: 3 }, 'waiting', 2],
    [{ running: 4, finished: 2 }, 'finished', 1],
    [{ running: 4, finished: 0 }, 'running', 0],
    [{ running: 0, finished: 2, waiting: 3 }, 'waiting', 1],
    [{ running: 0, finished: 2 }, 'finished', 0],
    [{ running: 0, finished: 0, waiting: 0 }, undefined, 0],
    [{ running: 0, finished: 0 }, undefined, 0]
  ] as const)('prioriza a atividade e conta os estados adicionais: %j', (activity, primary, extra) => {
    expect(projectStatus(activity)).toEqual({ primary, extra })
  })
})
