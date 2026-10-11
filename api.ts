/**
 * Minimal client for the local OpenCode HTTP API.
 *
 * The plugin context covers most of what the bridge needs, but two things are
 * missing from it:
 *
 *  - the interactive question forms the agent can raise (`/api/form`), so a
 *    question asked on the desktop could not be answered from the phone;
 *  - a session list, so `/list` could only ever show sessions the bridge itself
 *    had created.
 *
 * The server publishes its address and password in the service registration
 * file, and authenticates with HTTP Basic (`opencode:<password>`), so a plugin
 * running inside that same server can talk to it directly. Every call is
 * best-effort: when the registration is missing or stale the API features
 * degrade instead of breaking the bridge.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Where the service publishes its address, password, pid and version.
 *
 * `WECHAT_SERVICE_FILE` replaces the search entirely, which is what tests use
 * and what a `--standalone` user needs when the default registration belongs to
 * a different server process.
 */
export function registrationPaths(): string[] {
  const override = process.env.WECHAT_SERVICE_FILE?.trim()
  if (override) return [override]
  // Two candidates can resolve to the same path when XDG_STATE_HOME is unset;
  // dedupe so callers (and the self-check output) see one entry per file.
  return [
    ...new Set([
      join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode", "service.json"),
      join(homedir(), ".local", "state", "opencode", "service.json"),
    ]),
  ]
}

export interface Registration {
  id?: string
  version?: string
  url: string
  pid: number
  password?: string
}

export interface LocalApiOptions {
  /** Consider the registration stale after this long. */
  cacheMs?: number
  timeoutMs?: number
  /**
   * Explicit registration file.
   *
   * Overrides discovery entirely. Tests use it, and it is what a `--standalone`
   * user needs when the default registration belongs to a different process.
   */
  file?: string
}

/** One session as the API reports it (only the fields the bridge uses). */
export interface ApiSession {
  id: string
  title?: string
  parentID?: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  cost?: number
  time?: { created?: number; updated?: number; archived?: number }
  location?: { directory?: string }
  outcome?: string
}

export interface ApiFormFieldOption {
  value: string
  label: string
  description?: string
}

/**
 * One question in a form.
 *
 * Field names mirror what the service actually sends (`title`, `key`,
 * `options`); an earlier version of this interface guessed `label` instead of
 * `title`, which the type check caught.
 */
export interface ApiFormField {
  /** Answer key. Required by the service. */
  key: string
  /** Human-readable question. */
  title?: string
  description?: string
  required?: boolean
  hidden?: boolean
  type?: "string" | "number" | "integer" | "boolean" | "multiselect" | "external"
  options?: ApiFormFieldOption[]
  /** Free text allowed alongside the offered options. */
  custom?: boolean
  default?: unknown
  minimum?: number
  maximum?: number
  when?: unknown
}

export interface ApiForm {
  id: string
  sessionID: string
  title: string
  metadata?: Record<string, unknown>
  fields: ApiFormField[]
  state?: { status: string }
}

export type ApiResult<T> = { ok: true; data?: T } | { ok: false; reason: string }

export class LocalApi {
  readonly #cacheMs: number
  readonly #timeoutMs: number
  readonly #file?: string
  #registration?: Registration
  #readAt = 0

  constructor(options: LocalApiOptions = {}) {
    this.#cacheMs = options.cacheMs ?? 20_000
    this.#timeoutMs = options.timeoutMs ?? 10_000
    this.#file = options.file?.trim() || undefined
  }

  /** True when a registration file exists, whether or not calls succeed. */
  get available(): boolean {
    return this.#read() !== undefined
  }

  /** True when this plugin's process is the service the registration points at. */
  get isSelf(): boolean {
    const info = this.#read()
    return Boolean(info && info.pid === process.pid)
  }

  #read(): Registration | undefined {
    const now = Date.now()
    if (this.#registration && now - this.#readAt < this.#cacheMs) return this.#registration
    const candidates = this.#file ? [this.#file] : registrationPaths()
    for (const path of candidates) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Registration
        if (typeof parsed?.url === "string" && typeof parsed.pid === "number") {
          this.#registration = parsed
          this.#readAt = now
          return parsed
        }
      } catch {
        // Try the next candidate.
      }
    }
    this.#registration = undefined
    this.#readAt = now
    return undefined
  }

  /** Drop the cached registration so the next call re-reads it. */
  invalidate(): void {
    this.#registration = undefined
    this.#readAt = 0
  }

  /**
   * One request, with success and failure kept apart.
   *
   * A successful mutating call answers 204 with no body, so "empty response"
   * must not be read as "nothing came back" — treating the two as the same made
   * a submitted form look like a rejected one.
   */
  async #request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<ApiResult<T>> {
    const info = this.#read()
    if (!info) return { ok: false, reason: "service registration not found" }

    const headers: Record<string, string> = { accept: "application/json" }
    if (info.password) {
      headers.authorization = `Basic ${Buffer.from(`opencode:${info.password}`, "utf8").toString("base64")}`
    }
    if (body !== undefined) headers["content-type"] = "application/json"

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const response = await fetch(`${info.url}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        this.invalidate()
        return { ok: false, reason: `${method} ${path} -> HTTP ${response.status} ${text.slice(0, 120)}` }
      }
      if (!text) return { ok: true }
      try {
        return { ok: true, data: JSON.parse(text) as T }
      } catch {
        return { ok: true }
      }
    } catch (error) {
      // A moved or restarted service must not poison the cache.
      this.invalidate()
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Sessions visible to the whole service, newest first.
   *
   * The plugin context has no `session.list`, so this is the only way to show
   * sessions the bridge did not create.
   */
  async listSessions(params: { limit?: number; directory?: string; search?: string } = {}): Promise<ApiSession[]> {
    const query = new URLSearchParams()
    if (params.limit) query.set("limit", String(params.limit))
    if (params.directory) query.set("directory", params.directory)
    if (params.search) query.set("search", params.search)
    const suffix = query.toString()
    const result = await this.#request<{ data?: ApiSession[] }>("GET", `/api/session${suffix ? `?${suffix}` : ""}`)
    return result.ok ? (result.data?.data ?? []) : []
  }

  async getSession(sessionID: string): Promise<ApiSession | undefined> {
    const result = await this.#request<{ data?: ApiSession }>("GET", `/api/session/${encodeURIComponent(sessionID)}`)
    return result.ok ? result.data?.data : undefined
  }

  /** Interactive questions the agent raised, newest first. */
  async listForms(sessionID?: string): Promise<ApiForm[]> {
    if (sessionID) {
      const result = await this.#request<{ data?: ApiForm[] }>(
        "GET",
        `/api/session/${encodeURIComponent(sessionID)}/form`,
      )
      return result.ok ? (result.data?.data ?? []) : []
    }
    const result = await this.#request<{ data?: ApiForm[] }>("GET", "/api/form")
    return result.ok ? (result.data?.data ?? []) : []
  }

  async getForm(sessionID: string, formID: string): Promise<ApiForm | undefined> {
    const result = await this.#request<{ data?: ApiForm }>(
      "GET",
      `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`,
    )
    return result.ok ? result.data?.data : undefined
  }

  /** Answer a form. Values are keyed by the field key the API reported. */
  async replyForm(sessionID: string, formID: string, answer: Record<string, unknown>): Promise<boolean> {
    const result = await this.#request<unknown>(
      "POST",
      `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}/reply`,
      { answer },
    )
    return result.ok
  }

  async cancelForm(sessionID: string, formID: string): Promise<boolean> {
    const result = await this.#request<unknown>(
      "DELETE",
      `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`,
    )
    return result.ok
  }

  /** Pending permission requests across the service. */
  async listPermissionRequests(): Promise<Array<Record<string, unknown>>> {
    const result = await this.#request<{ data?: Array<Record<string, unknown>> }>("GET", "/api/permission/request")
    return result.ok ? (result.data?.data ?? []) : []
  }

  /**
   * Sessions with a turn in flight, keyed by session id.
   *
   * Used by `/attach` and auto-follow to answer "what is the desktop working on
   * right now" — a running session is the strongest signal available, since
   * the API does not report which window is focused.
   */
  async listActiveSessions(): Promise<string[]> {
    const result = await this.#request<{ data?: Record<string, unknown> }>("GET", "/api/session/active")
    return result.ok && result.data?.data ? Object.keys(result.data.data) : []
  }

  /** Whether the service answers at all, for the health report. */
  async info(): Promise<{ version?: string; url?: string; pid?: number } | undefined> {
    const info = this.#read()
    const result = await this.#request<{ version?: string; pid?: number }>("GET", "/api/info")
    if (!result.ok || !result.data) return undefined
    return { version: result.data.version, pid: result.data.pid, url: info?.url }
  }

  /** Last failure reason, for diagnostics. */
  lastError?: string
}
