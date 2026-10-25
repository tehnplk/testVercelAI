import { nativeImage, type NativeImage } from 'electron'
import { basename, extname } from 'path'
import { existsSync } from 'fs'
import { tool, type UserModelMessage } from 'ai'
import { z } from 'zod'

// Long side in pixels; a bigger image costs more tokens without reading better.
const maxSide = 1568
// Smallest region side in pixels; a smaller crop is grown around its centre.
const minRegion = 32
// Attached images sent with one message; more are left for viewImage.
const maxAttached = 5
const imageExt = /^\.(png|jpe?g|webp|gif|bmp)$/i
// The renderer (App.tsx send) appends attached file paths, one per line, after this.
const attachHead = '\n\nไฟล์แนบ:\n'

type Region = { x: number; y: number; width: number; height: number }
type Viewed = { file: string; text: string; data: string }

// The typed text and the attached file paths of a user message.
export function splitAttachments(content: string): { text: string; files: string[] } {
  const at = content.indexOf(attachHead)
  if (at < 0) return { text: content, files: [] }
  return { text: content.slice(0, at), files: content.slice(at + attachHead.length).split('\n').filter(Boolean) }
}

// The image shrunk to maxSide on its long side; one side given keeps the aspect ratio.
function fit(image: NativeImage): NativeImage {
  const { width, height } = image.getSize()
  if (Math.max(width, height) <= maxSide) return image
  return image.resize(width >= height ? { width: maxSide, quality: 'best' } : { height: maxSide, quality: 'best' })
}

// The user message with its attached images as image parts, so the model sees them without viewImage.
// The text keeps every path, so the agent can still work on the files. An image that cannot be sent gets a
// note line instead, starting with a newline so the chat does not show it as an attached file (App.tsx).
// All agentModels (llm_model.ts) take images; a model without image input would need a check here.
// llm_memory.ts swaps the images for a note in later turns.
export function withAttachedImages(content: string): UserModelMessage {
  const images = splitAttachments(content).files.filter((f) => imageExt.test(extname(f)))
  if (!images.length) return { role: 'user', content }
  return {
    role: 'user',
    content: [
      { type: 'text', text: content },
      ...images.map((path, i) => {
        const file = basename(path)
        if (i >= maxAttached)
          return { type: 'text' as const, text: `\n[ภาพ ${file} ไม่ได้ส่งให้ดู (แนบเกิน ${maxAttached} ภาพ) หากต้องดูให้เรียก viewImage]` }
        const image = existsSync(path) ? nativeImage.createFromPath(path) : nativeImage.createEmpty()
        if (image.isEmpty())
          return {
            type: 'text' as const,
            text: `\n[ภาพ ${file} ส่งให้ดูไม่ได้: ไม่พบไฟล์ เสีย หรือไม่ใช่ PNG/JPEG หากต้องดูให้แปลงเป็น PNG ด้วย Bash แล้วเรียก viewImage]`
          }
        return {
          type: 'file' as const,
          mediaType: 'image/jpeg',
          // llm_memory.ts names the image by this in later turns.
          filename: file,
          data: { type: 'data' as const, data: fit(image).toJPEG(85).toString('base64') }
        }
      })
    ]
  }
}

// Start and length in pixels of one side of a region: cut to the image, at least minRegion long.
function span(start: number, size: number, full: number): [number, number] {
  const end = Math.min(1, start + size)
  const len = Math.min(full, Math.max(minRegion, Math.round((end - start) * full)))
  const from = Math.round(((start + end) / 2) * full - len / 2)
  return [Math.max(0, Math.min(full - len, from)), len]
}

// Read-only, so it runs without Jev or the approval card.
// The image reaches the model inside the tool result; llm_memory.ts swaps it for a note in later turns.
export const imageTools = {
  viewImage: tool({
    description:
      "Look at an image file (PNG, JPEG) on the user's computer. Convert other formats to PNG with Bash first. " +
      `Images are shrunk to ${maxSide}px on the long side, so small details of a big image get blurred. ` +
      'To read small text, handwriting, numbers in tables or other fine details, zoom: call viewImage again with a region ' +
      'around that part; a small region comes back at the full original resolution. ' +
      'Look at the whole image first, then call viewImage again with other regions as needed.',
    inputSchema: z.object({
      // Shown to the user as the call's input in the chat, like Bash's purpose.
      purpose: z.string().describe('In Thai, one short sentence: what you look at the image for'),
      path: z.string().describe('Full Windows path of the image, e.g. C:\\Users\\me\\Desktop\\photo.png'),
      region: z
        .object({
          x: z.number().describe('Left edge, 0-1 of the image width'),
          y: z.number().describe('Top edge, 0-1 of the image height'),
          width: z.number().describe('Width, 0-1 of the image width'),
          height: z.number().describe('Height, 0-1 of the image height')
        })
        .optional()
        .describe(
          'Part of the image to zoom into, as fractions of the whole image (0-1, x/y = top-left corner), e.g. {x:0.5,y:0,width:0.5,height:0.25} for the top right. Leave out to see the whole image.'
        )
    }),
    execute: async ({ path, region }: { purpose: string; path: string; region?: Region }): Promise<Viewed | string> => {
      // Only the base name in errors, so the chat does not show the missing file as a link.
      const file = basename(path)
      if (region) {
        const { x, y, width: w, height: h } = region
        if (!(x >= 0 && x < 1 && y >= 0 && y < 1))
          return `Cannot view ${file}: region x and y must be fractions from 0 to below 1 (top-left corner), got x=${x}, y=${y}.`
        if (!(w > 0 && w <= 1 && h > 0 && h <= 1))
          return `Cannot view ${file}: region width and height must be fractions above 0 and at most 1, got width=${w}, height=${h}.`
      }
      if (!existsSync(path)) return `Cannot view ${file}: file not found.`
      let image = nativeImage.createFromPath(path)
      if (image.isEmpty())
        return `Cannot view ${file}: it is empty, damaged or not a PNG/JPEG image. Convert it to PNG with Bash (Pillow) first.`
      const full = image.getSize()
      let text = `Image ${file}: original ${full.width}x${full.height} px`
      if (region) {
        const [left, width] = span(region.x, region.width, full.width)
        const [top, height] = span(region.y, region.height, full.height)
        image = image.crop({ x: left, y: top, width, height })
        text += `, region x=${left} y=${top} ${width}x${height} px`
      }
      image = fit(image)
      const size = image.getSize()
      text += `, returned ${size.width}x${size.height} px`
      return { file, text, data: image.toJPEG(85).toString('base64') }
    },
    toModelOutput: ({ output }: { output: Viewed | string }) =>
      typeof output === 'string'
        ? { type: 'text' as const, value: output }
        : {
            type: 'content' as const,
            value: [
              { type: 'text' as const, text: output.text },
              {
                type: 'file' as const,
                mediaType: 'image/jpeg',
                // llm_memory.ts names the image by this in later turns, and the chat shows it as the output.
                filename: output.file,
                data: { type: 'data' as const, data: output.data }
              }
            ]
          }
  })
}
