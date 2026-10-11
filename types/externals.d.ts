/**
 * Ambient declarations for optional runtime dependencies.
 *
 * `qrcode` and `qrcode-terminal` ship no types of their own and are loaded
 * lazily, so the plugin only ever needs the two calls it makes. Declaring them
 * here keeps `tsc --noEmit` honest about everything else.
 */

declare module "qrcode" {
  export function toFile(path: string, text: string, options?: unknown): Promise<void>
  export function toDataURL(text: string, options?: unknown): Promise<string>
  export function toString(text: string, options?: unknown): Promise<string>
  const qrcode: { toFile: typeof toFile; toDataURL: typeof toDataURL; toString: typeof toString }
  export default qrcode
}

declare module "qrcode-terminal" {
  export function generate(text: string, options?: unknown, callback?: (qr: string) => void): void
  const terminal: { generate: typeof generate }
  export default terminal
}
