import { nativeImage } from 'electron'
import { basename } from 'path'
import { existsSync } from 'fs'
import { tool } from 'ai'
import { z } from 'zod'

// Long side in pixels; a bigger image costs more tokens without reading better.
const maxSide = 1568

type Viewed = { file: string; width: number; height: number; data: string }

// Read-only, so it runs without Jev or the approval card.
// The image reaches the model inside the tool result; llm_memory.ts swaps it for a note in later turns.
export const imageTools = {
  viewImage: tool({
    description:
      "Look at an image file (PNG, JPEG) on the user's computer. Convert other formats to PNG with Bash first.",
    inputSchema: z.object({
      // Shown to the user as the call's input in the chat, like Bash's purpose.
      purpose: z.string().describe('In Thai, one short sentence: what you look at the image for'),
      path: z.string().describe('Full Windows path of the image, e.g. C:\\Users\\me\\Desktop\\photo.png')
    }),
    execute: async ({ path }: { purpose: string; path: string }): Promise<Viewed | string> => {
      // Only the base name in errors, so the chat does not show the missing file as a link.
      const file = basename(path)
      if (!existsSync(path)) return `Cannot view ${file}: file not found.`
      let image = nativeImage.createFromPath(path)
      if (image.isEmpty())
        return `Cannot view ${file}: it is empty, damaged or not a PNG/JPEG image. Convert it to PNG with Bash (Pillow) first.`
      const { width, height } = image.getSize()
      // One side given keeps the aspect ratio.
      if (Math.max(width, height) > maxSide)
        image = image.resize(width >= height ? { width: maxSide, quality: 'best' } : { height: maxSide, quality: 'best' })
      const size = image.getSize()
      return { file, width: size.width, height: size.height, data: image.toJPEG(85).toString('base64') }
    },
    toModelOutput: ({ output }: { output: Viewed | string }) =>
      typeof output === 'string'
        ? { type: 'text' as const, value: output }
        : {
            type: 'content' as const,
            value: [
              { type: 'text' as const, text: `Image ${output.file} (${output.width}x${output.height} px)` },
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
