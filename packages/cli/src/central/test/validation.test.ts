import { expect, test } from 'vitest'
import type { Resource } from '@agentweave/protocol'
import { validateImport } from '../validation.js'

function skill(name: string, description: string): Resource {
  const text = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\nContent\n`
  return {
    kind: 'skill',
    id: name,
    name,
    files: { 'SKILL.md': Buffer.from(text).toString('base64') },
  }
}

test('reports the actual and permitted lengths for Agent Skills metadata', () => {
  expect(() => validateImport(skill('a'.repeat(65), 'valid'))).toThrow(
    '最多 64 个字符；当前 65 个字符',
  )
  expect(() => validateImport(skill('valid', '好'.repeat(1025)))).toThrow(
    '最多 1024 个字符；当前 1025 个字符',
  )
  expect(() => validateImport(skill('ABC', 'valid'))).toThrow(
    '不能包含大写字母',
  )
  expect(() => validateImport(skill('a_b', 'valid'))).toThrow(
    '只能包含小写字母',
  )
  expect(() => validateImport(skill('-abc', 'valid'))).toThrow('不能以连字符')
  expect(() => validateImport(skill('a--b', 'valid'))).toThrow(
    '不能包含连续的连字符',
  )
  expect(() => validateImport(skill('valid', '  '))).toThrow('当前 2 个字符')
})
