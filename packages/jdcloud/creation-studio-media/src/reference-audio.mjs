/** Fit selected narration samples within the Seedance batch's remaining audio budget. */
import { decoder as wavDecoder } from '@audio/decode-wav'
import { CouldNotDetermineFileTypeError, parseBuffer, UnsupportedFileTypeError } from 'music-metadata'
import { MPEGDecoder } from 'mpg123-decoder'
import { MIN_REFERENCE_AUDIO_SECONDS } from './seedance-request.mjs'

/**
 * Read an MP3 or WAV reference using its actual container.
 * @param bytes - File bytes within the reference upload limit.
 * @param declaredMime - Parser hint for files without a detectable header.
 * @returns The measured audio and its provider MIME type.
 */
export async function parseReferenceAudio(bytes, declaredMime) {
  const options = { duration: true, skipCovers: true }
  let metadata
  try {
    metadata = await parseBuffer(bytes, undefined, options)
  } catch (error) {
    if (!(error instanceof CouldNotDetermineFileTypeError)) throw error
    metadata = await parseBuffer(bytes, { mimeType: declaredMime }, options)
  }

  const { container, codec, duration, sampleRate, numberOfChannels: channels } = metadata.format
  const mime = container === 'WAVE' ? 'audio/wav'
    : container === 'MPEG' && /Layer 3$/u.test(codec) ? 'audio/mp3' : undefined
  if (mime === undefined)
    throw new UnsupportedFileTypeError('Expected WAV or MPEG Layer 3 reference audio')
  return { bytes, mime, duration, sampleRate, channels }
}

/**
 * Keep short samples intact and limit longer ones to a common duration.
 * @param lengths - Durations measured from the original voice files.
 * @param available - Seconds left after accounting for project reference audio.
 * @returns A cap in seconds, or undefined if a valid sample for every voice cannot fit.
 */
export function narrationSampleCap(lengths, available) {
  if (available + 1e-9 < lengths.length * MIN_REFERENCE_AUDIO_SECONDS) return undefined
  const ordered = lengths.toSorted((a, b) => a - b)
  for (const [index, length] of ordered.entries()) {
    const cap = available / (ordered.length - index)
    if (length > cap) return Math.max(MIN_REFERENCE_AUDIO_SECONDS, Math.floor(cap * 1000) / 1000)
    available -= length
  }
  return undefined
}

async function openDecoder(mime) {
  if (mime === 'audio/wav') return wavDecoder()
  const decoder = new MPEGDecoder()
  await decoder.ready
  return decoder
}

/**
 * Decode the beginning of a voice sample to a new PCM WAV for the provider.
 * @param sample - The validated WAV or MP3 bytes, sample rate, and channel count.
 * @param seconds - The maximum amount of audio to send for this voice.
 * @returns A WAV buffer with its exact frame-based duration.
 */
export async function trimVoiceSample({ bytes, mime, sampleRate, channels }, seconds) {
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000 || ![1, 2].includes(channels))
    throw new Error('Unsupported voice sample rate or channel count.')

  const frameCount = Math.floor(seconds * sampleRate)
  const frameBytes = channels * 2
  const wav = Buffer.alloc(44 + frameCount * frameBytes)
  const decoder = await openDecoder(mime)
  // mpg123 returns stereo PCM for mono inputs as well.
  const decodedChannels = mime === 'audio/wav' ? channels : 2
  let written = 0
  try {
    const chunkBytes = 64 * 1024
    for (let offset = 0; offset < bytes.length && written < frameCount; offset += chunkBytes) {
      const decoded = decoder.decode(bytes.subarray(offset, offset + chunkBytes))
      const count = Math.min(decoded.channelData[0]?.length ?? 0, frameCount - written)
      if (!count) continue
      if (decoded.sampleRate !== sampleRate || decoded.channelData.length !== decodedChannels || decoded.errors?.length)
        throw new Error('Voice sample decoder reported invalid audio.')
      for (let index = 0; index < count; index++) {
        for (let channel = 0; channel < channels; channel++) {
          const sample = decoded.channelData[channel][index]
          wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), 44 + (written * channels + channel) * 2)
        }
        written++
      }
    }
  } finally {
    decoder.free()
  }
  if (written < sampleRate * MIN_REFERENCE_AUDIO_SECONDS) throw new Error('Decoded voice sample is too short.')

  const dataBytes = written * frameBytes
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + dataBytes, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(channels, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * frameBytes, 28)
  wav.writeUInt16LE(frameBytes, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(dataBytes, 40)
  return { bytes: wav.subarray(0, 44 + dataBytes), mime: 'audio/wav', duration: written / sampleRate }
}
