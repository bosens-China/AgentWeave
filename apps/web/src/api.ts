import type { Api, ApiAction, Resource } from '@agentweave/protocol'

export async function request<A extends ApiAction>(
  action: A,
  payload?: Api[A]['request'],
  signal?: AbortSignal,
): Promise<Api[A]['response']> {
  const response = await fetch(`/api/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    signal,
  })
  const content: unknown = await response.json().catch(() => null)
  if (!response.ok || content === null) {
    throw new Error(
      content &&
        typeof content === 'object' &&
        'error' in content &&
        typeof content.error === 'string' &&
        content.error
        ? content.error
        : `本机服务返回了无法读取的响应（${response.status}）。`,
    )
  }
  return content as Api[A]['response']
}

export const resourceKey = ({ kind, id }: Pick<Resource, 'kind' | 'id'>) =>
  `${kind}:${id}`

export function decodeFile(value: string) {
  try {
    const bytes = Uint8Array.from(atob(value), (character) =>
      character.charCodeAt(0),
    )
    if (bytes.includes(0)) return null
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export function encodeFile(value: string) {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
