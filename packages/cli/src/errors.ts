export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error
    ? error.code
    : undefined
}
