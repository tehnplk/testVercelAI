import { nativeImage } from 'electron'
import { basename } from 'path'
import { existsSync } from 'fs'
import { tool } from 'ai'
import { z } from 'zod'

// Long side in pixels; a bigger image costs more tokens without reading better.
const maxSide = 1568
// Smallest region side in pixels; a smaller crop is grown around its centre.
const minRegion = 32

type Region = { x: number; y: number; width: number; height: number }
type Viewed = { file: string; text: string; data: string }

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
      const { width, height } = image.getSize()
      // One side given keeps the aspect ratio.
      if (Math.max(width, height) > maxSide)
        image = image.resize(width >= height ? { width: maxSide, quality: 'best' } : { height: maxSide, quality: 'best' })
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
