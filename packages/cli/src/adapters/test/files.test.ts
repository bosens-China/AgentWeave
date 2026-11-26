import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { readTree } from '../files.js'

test('reports the full size and the applicable file-count limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentweave-size-'))
  try {
    await writeFile(join(directory, 'a'), '12345678')
    await writeFile(join(directory, 'b'), '123456789')
    await writeFile(join(directory, 'c'), '12345')
    await expect(readTree(directory, { maxBytes: 10 })).rejects.toThrow(
      '最大 10 字节，当前 22 字节',
    )
    await expect(readTree(directory, { maxFiles: 1 })).rejects.toThrow(
      '最多 1 个，已发现 2 个',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
