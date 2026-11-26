# AgentWeave npm integration example

This package contains one Skill and an MCP echo server. The setup command checks
for AgentWeave CLI integration API v1 before asking it to preview distribution.

```sh
agentweave-example-bundle setup --agent claude
```

Add `--apply` to confirm the preview. To point the example at a local build, pass
`--agentweave /absolute/path/to/cli.mjs`. To allow npm to fetch the tested
AgentWeave version when no compatible CLI is installed, pass `--with-npx`.
