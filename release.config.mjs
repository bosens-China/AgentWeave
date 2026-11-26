const conventionalCommits = {
  preset: 'conventionalcommits',
  presetConfig: {},
}

export default {
  branches: ['main'],
  plugins: [
    ['@semantic-release/commit-analyzer', conventionalCommits],
    ['@semantic-release/release-notes-generator', conventionalCommits],
    ['@semantic-release/npm', { pkgRoot: 'packages/cli' }],
    [
      '@semantic-release/github',
      { successComment: false, failComment: false, releasedLabels: false },
    ],
  ],
}
