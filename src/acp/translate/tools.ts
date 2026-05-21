/**
 * Convert a zot `tool_result` event payload (the `content` array) into a plain
 * text representation suitable for ACP `tool_call_update.content`.
 *
 * zot tool results are arrays of ContentBlock; for the built-in tools the
 * relevant block is a single `text` block. Bash output is included as plain
 * text — there is no separate stdout/stderr field in zot's wire format.
 */
export function toolResultToText(result: unknown): string {
  if (!result) return ''

  // zot's event shape is `{type:"tool_result", id, is_error, content:[...]}`.
  // Callers may pass the whole event or just `content`.
  const content = Array.isArray((result as any)?.content)
    ? (result as any).content
    : Array.isArray(result)
      ? (result as any[])
      : null

  if (Array.isArray(content)) {
    const texts = content
      .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
    if (texts.length) return texts.join('')

    const images = content.filter((c: any) => c?.type === 'image')
    if (images.length) {
      return images
        .map((c: any) => {
          const mt = typeof c?.mime_type === 'string' ? c.mime_type : 'image'
          const bytes = typeof c?.bytes === 'number' ? `, ${c.bytes} bytes` : ''
          return `[image: ${mt}${bytes}]`
        })
        .join('\n')
    }
  }

  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}
