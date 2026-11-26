import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const { default: release } = await import(
  new URL('../release.config.mjs', import.meta.url).href
)
const require = createRequire(import.meta.resolve('semantic-release'))
const [[analyzerName, analyzerOptions], [notesName, notesOptions]] =
  release.plugins
const { analyzeCommits } = await import(
  pathToFileURL(require.resolve(analyzerName)).href
)
const { generateNotes } = await import(
  pathToFileURL(require.resolve(notesName)).href
)

const context = {
  cwd: process.cwd(),
  logger: { log() {} },
  options: { repositoryUrl: 'https://github.com/example/agentweave.git' },
  lastRelease: { gitTag: 'v0.1.0' },
  nextRelease: { gitTag: 'v0.2.0', version: '0.2.0' },
}
const cases = [
  {
    messages: ['docs: explain installation', 'chore: update tooling'],
    release: null,
  },
  { messages: ['fix(cli): validate a flag'], release: 'patch' },
  { messages: ['perf: speed up resource scanning'], release: 'patch' },
  {
    messages: ['feat: distribute npm resources', 'fix: validate a flag'],
    release: 'minor',
  },
  { messages: ['feat!: change the public interface'], release: 'major' },
  {
    messages: [
      'fix: change the interface\n\nBREAKING CHANGE: the previous interface is removed',
    ],
    release: 'major',
  },
]
for (const { messages, release: expected } of cases) {
  const commits = messages.map((message, index) => ({
    message,
    hash: String(index + 1).padStart(40, '0'),
  }))
  assert.equal(
    await analyzeCommits(analyzerOptions, { ...context, commits }),
    expected,
  )
}

const notes = await generateNotes(notesOptions, {
  ...context,
  commits: [
    { message: 'feat: distribute npm resources', hash: 'a'.repeat(40) },
  ],
})
assert.match(notes, /distribute npm resources/)
console.log('Conventional commit release types and release notes verified.')
