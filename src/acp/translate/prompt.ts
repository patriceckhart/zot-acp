import type { ContentBlock } from '@agentclientprotocol/sdk'

export type ZotImage = {
  mime_type: string
  data: string
}

/**
 * Convert ACP prompt blocks into the `{message, images}` pair zot's
 * `prompt` command expects.
 */
export function promptToZotMessage(blocks: ContentBlock[]): {
  message: string
  images: ZotImage[]
} {
  let message = ''
  const images: ZotImage[] = []

  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        message += b.text
        break

      case 'resource_link':
        message += `\n[Context] ${b.uri}`
        break

      case 'image': {
        // zot expects base64 image bytes in `data` without a data-url prefix.
        images.push({
          mime_type: b.mimeType,
          data: b.data
        })
        break
      }

      case 'resource': {
        const r: any = (b as any).resource
        const uri = typeof r?.uri === 'string' ? r.uri : '(unknown)'

        if (typeof r?.text === 'string') {
          const mime = typeof r?.mimeType === 'string' ? r.mimeType : 'text/plain'
          message += `\n[Embedded Context] ${uri} (${mime})\n${r.text}`
        } else if (typeof r?.blob === 'string') {
          const mime = typeof r?.mimeType === 'string' ? r.mimeType : 'application/octet-stream'
          const bytes = Buffer.byteLength(r.blob, 'base64')
          message += `\n[Embedded Context] ${uri} (${mime}, ${bytes} bytes)`
        } else {
          message += `\n[Embedded Context] ${uri}`
        }
        break
      }

      case 'audio': {
        const bytes = Buffer.byteLength(b.data, 'base64')
        message += `\n[Audio] (${b.mimeType}, ${bytes} bytes) not supported by zot-acp`
        break
      }

      default:
        break
    }
  }

  return { message, images }
}
