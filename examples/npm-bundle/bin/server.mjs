#!/usr/bin/env node
import { createInterface } from 'node:readline'

const version = '2026-07-28'
const legacy = '2025-11-25'
const serverInfo = { name: 'agentweave-example-echo', version: '0.1.0' }
const capabilities = { tools: {} }
const tool = {
  name: 'echo',
  description: 'Return the provided text unchanged.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of input) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    continue
  }
  if (!message || message.jsonrpc !== '2.0' || !Object.hasOwn(message, 'id'))
    continue
  const { method, id, params } = message
  const reply = (fields) => {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, ...fields })}\n`,
    )
  }
  const result = (fields) =>
    reply({
      result:
        params?._meta?.['io.modelcontextprotocol/protocolVersion'] ===
          version || method === 'server/discover'
          ? { resultType: 'complete', ...fields }
          : fields,
    })
  if (method === 'server/discover') {
    result({
      supportedVersions: [version],
      capabilities,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    })
  } else if (method === 'initialize') {
    result({ protocolVersion: legacy, capabilities, serverInfo })
  } else if (method === 'tools/list') {
    result({ tools: [tool] })
  } else if (method === 'tools/call') {
    if (
      params?.name !== tool.name ||
      typeof params.arguments?.text !== 'string'
    )
      reply({
        error: {
          code: -32602,
          message: 'Expected the echo tool with a text argument',
        },
      })
    else result({ content: [{ type: 'text', text: params.arguments.text }] })
  } else if (method === 'ping') {
    result({})
  } else {
    reply({ error: { code: -32601, message: 'Unknown method' } })
  }
}
