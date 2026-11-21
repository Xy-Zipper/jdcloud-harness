import { resolve } from 'node:path'
import { z } from 'zod'

/**
 * Read the public environment from the verified build record for this checkout.
 * @returns The values embedded in the Web artifacts.
 */
export async function readWebClientBuildEnvironment(): Promise<Readonly<Record<string, string | undefined>>> {
  const scriptPath = '../../../scripts/client-build-environment.ts'
  const { readClientBuildRecord }: Record<string, unknown> = await import(scriptPath)
  if (typeof readClientBuildRecord !== 'function') throw new TypeError('client build record reader is missing')
  const record: unknown = readClientBuildRecord(resolve(import.meta.dirname, '../../..'))
  return z.object({ environment: z.record(z.string(), z.string()) }).parse(record).environment
}
