/** Slash commands for the intelligence terminal (see `use-agent-intelligence`). */

import { layerSlashValidNamesHint, normalizeLayerSlashToken, type SlashLayerKey } from '@/lib/slash-layer-keys'

export type SlashCommandDef = {
  command: string
  summary: string
}

/** Upper bound for camera tilt (degrees) — matches `CommandMap` / `TiltController` (vector map). */
export const SLASH_MAP_TILT_MAX_DEG = 67.5

/** Implemented today — order is how they appear under `/`. */
export const SLASH_COMMANDS: SlashCommandDef[] = [
  { command: 'help', summary: 'List commands, tips, and roadmap ideas' },
  { command: 'view', summary: 'Map tilt: `/view 3d` or `/view 2d`' },
  {
    command: 'tilt',
    summary: '`/tilt 0–100`: percent of max tilt (0°–67.5°); see /help for bounds and edge cases',
  },
  {
    command: 'rotate',
    summary: '`/rotate <degrees>`: map bearing (clockwise from north); see /help for wrapping',
  },
  {
    command: 'go',
    summary: '`/go <zip | city | county | metro>`: same as sidebar search / agent navigate',
  },
  {
    command: 'save',
    summary: '`/save` or `/save <name>`: save loaded market or current map view to **Saved**',
  },
  {
    command: 'export',
    summary: '`/export`: open the saved-output PDF editor with live preview',
  },
  {
    command: 'layers',
    summary: '`/layers:a,b`: turn **on** listed layers (comma-separated); see /help',
  },
  {
    command: 'clear',
    summary: '`/clear:layers|terminal|memory|workspace`: see /help',
  },
  {
    command: 'restart',
    summary: '`/restart` then type `y` or `n`: wipe all `projectr-*` keys + reload, or cancel',
  },
]

/** Shown inside /help only — not executable yet. */
export const SLASH_COMMAND_IDEAS: string[] = [
  '/data: open right panel on Data tab',
  '/zip <5-digit or city>: same as sidebar search (or use `/go`)',
  '/brief: market brief PDF export',
  '/context: copy sanitized map context for debugging',
]

export function getSlashPaletteState(input: string): { open: boolean; matches: SlashCommandDef[] } {
  const t = input
  if (!t.startsWith('/') || /\s/.test(t)) return { open: false, matches: [] }

  const body = t.slice(1).toLowerCase()
  if (
    body === 'help' ||
    body === 'clear' ||
    body.startsWith('clear:') ||
    body === 'view' ||
    body === 'tilt' ||
    body === 'rotate' ||
    body === 'go' ||
    body === 'save' ||
    body === 'export' ||
    body === 'layers' ||
    body.startsWith('layers:') ||
    body === 'restart'
  )
    return { open: false, matches: [] }

  if (body === '') return { open: true, matches: [...SLASH_COMMANDS] }

  const matches = SLASH_COMMANDS.filter((c) => c.command.startsWith(body))
  return { open: true, matches: matches.length > 0 ? matches : [] }
}

/** Full `/tilt` usage (also sent when you run `/tilt` with no value). */
export function tiltSlashUsageLines(): string {
  return [
    'Usage: `/tilt <0–100>`: percent of maximum camera tilt (not degrees).',
    `• 0% → flat (0°). 100% → full pitch (${SLASH_MAP_TILT_MAX_DEG}°), same ceiling as the map 3D control.`,
    '• Decimals OK (`/tilt 33.3`). Optional percent sign (`/tilt 50%`); trailing % is stripped once.',
    '• Values below 0 or above 100 are clamped to 0–100; the reply notes when that happens.',
    '• One number only. Extra tokens after the value are rejected.',
    '• Non-numeric, empty, or Infinity values are rejected with a hint.',
    '• Presets: `/view 2d` = 0°; `/view 3d` = fixed 45° (`/tilt 66.7` is ~45° on this scale).',
  ].join('\n')
}

export function clearSlashUsageLines(): string {
  return [
    'Usage: `/clear:<target>`: no spaces around the colon.',
    '• `/clear:layers` turns **off** every map layer and clears any active permit-type filter (map view unchanged).',
    '• `/clear:terminal` keeps only the default greeting (the command is not echoed); case-brief bundle unchanged.',
    '• `/clear:memory` or `/clear:mem` keeps only the default greeting, clears the case-brief bundle, and does not reload, change market, or clear Client CSV.',
    '• `/clear:workspace` confirms, then wipes session keys (upload, pins, chat, pending nav) and reloads the tab.',
    '• **`/restart`** asks **Are you sure? y/n**; then send plain **`y`** / **`yes`** or **`n`** / **`no`** (no slash). One-line **`/restart y`** / **`/restart n`** also works.',
    '• Bare `/clear` is invalid. Pick a target. Unknown target → error with hints.',
  ].join('\n')
}

export function goSlashUsageLines(): string {
  return [
    'Usage: `/go <query>`: one line of text (ZIP, city, county, metro, or `City, ST`).',
    '• Runs the same navigation as the sidebar search (Enter).',
    '• Empty query after `/go` is rejected.',
    '• Extra leading/trailing spaces are trimmed.',
  ].join('\n')
}

export type ParsedExportSlash =
  | { kind: 'run' }
  | { kind: 'bad_arg'; message: string }

export function exportSlashUsageLines(): string {
  return [
    'Usage: `/export`: opens the saved-output PDF editor with a live preview.',
    '• The editor lists outputs saved from the terminal in this browser session.',
    '• Reorder sections, rename them, and add notes — the PDF preview updates live before you export.',
  ].join('\n')
}

export function parseExportSlashCommand(trimmed: string): ParsedExportSlash | null {
  const m = trimmed.match(/^\/export(?:\s+(.*))?\s*$/i)
  if (!m) return null
  const rest = (m[1] ?? '').trim()
  if (!rest) return { kind: 'run' }
  return {
    kind: 'bad_arg',
    message: 'Use `/export` with no extra text. Choose saved outputs and add notes in the export dialog.',
  }
}

export function layersSlashUsageLines(): string {
  return [
    'Usage: `/layers:name1,name2,...`: **colon required**; comma-separated names; turns **on** those layers (others unchanged).',
    `• ${layerSlashValidNamesHint()}`,
    '• Aliases: e.g. `rent` → rent/value fill, `client` → Client markers, `permits` → NYC permits (only when the active market is in New York City).',
    '• Empty list or unknown names → error listing bad tokens.',
    '• Duplicates are ignored once.',
  ].join('\n')
}

/** Shown after `/restart`; user then sends plain `y` or `n` (no leading slash). */
export const RESTART_CONFIRM_PROMPT_MESSAGE = 'Are you sure? y/n'

export function restartSlashUsageLines(): string {
  return [
    'Usage: terminal-style **two lines** (no browser `confirm`).',
    '• Send **`/restart`**. Prior transcript is cleared; only **Are you sure? y/n** appears (no echo of `/restart`).',
    '• Then send plain **`y`** or **`yes`** to wipe every `sessionStorage` / `localStorage` key starting with **`projectr-`** and reload (no extra lines before reload); **`n`** or **`no`** returns to the default greeting only.',
    '• Shortcut: **`/restart y`** or **`/restart n`** in one line (same as above).',
    '• Does **not** change Supabase, auth, or shortlist.',
    '• **`/clear:workspace`** uses a browser confirm + a fixed key list instead.',
    '• **`/help`**, **`/clear:memory`**, **`/clear:terminal`**, or **`/clear:layers`** cancels a pending restart prompt.',
  ].join('\n')
}

export function buildSlashHelpMessage(): string {
  const lines = [
    'Slash commands: type / then filter with letters; use ↑↓ and Enter to complete, or click a row.',
    '',
    'Available:',
    ...SLASH_COMMANDS.map((c) => `  /${c.command}: ${c.summary}`),
    '',
    '/tilt (detail):',
    ...tiltSlashUsageLines().split('\n').map((ln) => `  ${ln}`),
    '',
    '/rotate (detail):',
    ...rotateSlashUsageLines().split('\n').map((ln) => `  ${ln}`),
    '',
    '/clear (detail):',
    ...clearSlashUsageLines().split('\n').map((ln) => `  ${ln}`),
    '',
    '/go (detail):',
    ...goSlashUsageLines().split('\n').map((ln) => `  ${ln}`),
    '',
    '/export:',
    ...exportSlashUsageLines().split('\n').map((ln) => `  ${ln}`),
    '',
    '/save (detail):',
    ...saveSlashUsageLines().split('\n').map((ln) => `  ${ln}`),
    '',
    '/layers (detail):',
    ...layersSlashUsageLines().split('\n').map((ln) => `  ${ln}`),
    '',
    '/restart (detail):',
    ...restartSlashUsageLines().split('\n').map((ln) => `  ${ln}`),
    '',
    'Roadmap (not wired yet. Tell us what you want first):',
    ...SLASH_COMMAND_IDEAS.map((s) => `  ${s}`),
    '',
    'Anything starting with `/` is treated as a slash command. Unknown slash commands return a local error and are never sent to the Gemini agent.',
    'Natural-language prompts without `/` are sent to the Gemini agent only when they look related to Scout real estate, map, market, or uploaded-data work.',
  ]
  return lines.join('\n')
}

export type ParsedViewSlash =
  | { kind: 'run'; mode: '3d' | '2d' }
  | { kind: 'usage' }
  | { kind: 'bad_arg'; arg: string }

/** Non-`null` when the line starts with `/view` (with or without args). */
export function parseViewSlashCommand(trimmed: string): ParsedViewSlash | null {
  const m = trimmed.match(/^\/view(?:\s+(.*))?$/i)
  if (!m) return null
  const rest = (m[1] ?? '').trim().toLowerCase()
  if (!rest) return { kind: 'usage' }
  if (rest === '3d') return { kind: 'run', mode: '3d' }
  if (rest === '2d') return { kind: 'run', mode: '2d' }
  return { kind: 'bad_arg', arg: rest }
}

export type ParsedTiltSlash =
  | { kind: 'run'; tiltDegrees: number; userFacingSummary: string }
  | { kind: 'usage' }
  | { kind: 'bad_arg'; message: string }

function formatTiltDegrees(deg: number): string {
  const t = Math.round(deg * 10) / 10
  const nearInt = Math.round(t)
  if (Math.abs(t - nearInt) < 1e-6) return String(nearInt)
  return t.toFixed(1)
}

/** Non-`null` when the line starts with `/tilt` (with or without args). */
export function parseTiltSlashCommand(trimmed: string): ParsedTiltSlash | null {
  const m = trimmed.match(/^\/tilt(?:\s+(.*))?$/i)
  if (!m) return null
  const rawRest = (m[1] ?? '').trim()
  if (!rawRest) return { kind: 'usage' }

  const tokens = rawRest.split(/\s+/).filter(Boolean)
  if (tokens.length > 1) {
    return {
      kind: 'bad_arg',
      message: 'Use exactly one value after `/tilt` (e.g. `/tilt 50` or `/tilt 50%`).',
    }
  }

  const token = tokens[0].replace(/%+$/i, '').trim()
  if (token === '') {
    return { kind: 'bad_arg', message: 'Missing a number after `/tilt`. Example: `/tilt 50` (0–100% of max tilt).' }
  }

  const num = Number.parseFloat(token)
  if (!Number.isFinite(num)) {
    return {
      kind: 'bad_arg',
      message: `Could not parse “${tokens[0]}” as a number. Use 0–100 (optional %), finite values only.`,
    }
  }

  let clamped = num
  const clampNotes: string[] = []
  if (num < 0) {
    clamped = 0
    clampNotes.push(`input ${num}% clamped to 0%`)
  } else if (num > 100) {
    clamped = 100
    clampNotes.push(`input ${num}% clamped to 100%`)
  }

  const tiltDegrees = (clamped / 100) * SLASH_MAP_TILT_MAX_DEG
  const degStr = formatTiltDegrees(tiltDegrees)

  let userFacingSummary = `Map tilt ${degStr}° (${clamped}% of max ${SLASH_MAP_TILT_MAX_DEG}°).`
  if (clampNotes.length > 0) {
    userFacingSummary = `${clampNotes[0]}. ${userFacingSummary}`
  }

  return { kind: 'run', tiltDegrees, userFacingSummary }
}

/** Google Maps heading: clockwise from north, stored in [0, 360). */
export function normalizeHeadingDegrees(n: number): number {
  const h = ((n % 360) + 360) % 360
  return Object.is(h, -0) ? 0 : h
}

function formatHeadingDegrees(n: number): string {
  const t = Math.round(n * 10) / 10
  const nearInt = Math.round(t)
  if (Math.abs(t - nearInt) < 1e-6) return String(nearInt)
  return t.toFixed(1)
}

export function rotateSlashUsageLines(): string {
  return [
    'Usage: `/rotate <degrees>`: camera **bearing** (rotation), not tilt.',
    '• 0° = north up. Values increase **clockwise** (east = 90°, south = 180°, west = 270°).',
    '• Any finite number is accepted; the app **normalizes** to the range [0, 360) (e.g. 370° → 10°, −90° → 270°).',
    '• Decimals OK. Optional **°** suffix (`/rotate 45°`) is stripped.',
    '• One number only. Extra tokens are rejected.',
    '• Infinity / NaN / non-numeric input is rejected.',
  ].join('\n')
}

export type ParsedRotateSlash =
  | { kind: 'run'; headingDegrees: number; userFacingSummary: string }
  | { kind: 'usage' }
  | { kind: 'bad_arg'; message: string }

/** Non-`null` when the line starts with `/rotate` (with or without args). */
export function parseRotateSlashCommand(trimmed: string): ParsedRotateSlash | null {
  const m = trimmed.match(/^\/rotate(?:\s+(.*))?$/i)
  if (!m) return null
  const rawRest = (m[1] ?? '').trim()
  if (!rawRest) return { kind: 'usage' }

  const tokens = rawRest.split(/\s+/).filter(Boolean)
  if (tokens.length > 1) {
    return {
      kind: 'bad_arg',
      message: 'Use exactly one value after `/rotate` (e.g. `/rotate 45` or `/rotate 45°`).',
    }
  }

  const token = tokens[0].replace(/°$/u, '').replace(/\s+$/, '').trim()
  if (token === '') {
    return { kind: 'bad_arg', message: 'Missing degrees after `/rotate`. Example: `/rotate 90` (clockwise from north).' }
  }

  const num = Number.parseFloat(token)
  if (!Number.isFinite(num)) {
    return {
      kind: 'bad_arg',
      message: `Could not parse “${tokens[0]}” as a number. Use finite degrees (optional ° suffix).`,
    }
  }

  const norm = normalizeHeadingDegrees(num)
  let userFacingSummary = `Map heading ${formatHeadingDegrees(norm)}° (clockwise from north).`
  if (Math.abs(num - norm) > 1e-4) {
    userFacingSummary = `Input ${formatHeadingDegrees(num)}° normalized to ${formatHeadingDegrees(norm)}°. ${userFacingSummary}`
  }

  return { kind: 'run', headingDegrees: norm, userFacingSummary }
}

export type ParsedClearSlash =
  | { kind: 'run'; mode: 'layers' | 'terminal' | 'memory' | 'workspace' }
  | { kind: 'usage' }
  | { kind: 'bad_arg'; message: string }

export function parseClearSlashCommand(trimmed: string): ParsedClearSlash | null {
  if (!/^\/clear/i.test(trimmed)) return null
  const strict = trimmed.match(/^\/clear(?::(\w*))?\s*$/i)
  if (!strict) {
    return {
      kind: 'bad_arg',
      message:
        'Malformed `/clear` command. Use `/clear:layers`, `/clear:terminal`, `/clear:memory`, `/clear:mem`, or `/clear:workspace` with nothing extra after the target.',
    }
  }
  const sub = (strict[1] ?? '').toLowerCase()
  if (sub === '') return { kind: 'usage' }
  if (sub === 'layers') return { kind: 'run', mode: 'layers' }
  if (sub === 'terminal') return { kind: 'run', mode: 'terminal' }
  if (sub === 'memory' || sub === 'mem') return { kind: 'run', mode: 'memory' }
  if (sub === 'workspace') return { kind: 'run', mode: 'workspace' }
  return {
    kind: 'bad_arg',
    message: `Unknown /clear target “${strict[1]}”. Use \`layers\`, \`terminal\`, \`memory\` (or \`mem\`), or \`workspace\`. Type /help for what each does.`,
  }
}

export type ParsedGoSlash =
  | { kind: 'run'; query: string }
  | { kind: 'usage' }
  | { kind: 'bad_arg'; message: string }

export function parseGoSlashCommand(trimmed: string): ParsedGoSlash | null {
  const m = trimmed.match(/^\/go(?:\s+(.+))?\s*$/i)
  if (!m) return null
  const query = (m[1] ?? '').trim().replace(/\s+/g, ' ')
  if (!query) return { kind: 'usage' }
  if (query.length > 500) {
    return { kind: 'bad_arg', message: 'Search text is too long (max 500 characters). Try a shorter city, county, metro, or ZIP.' }
  }
  return { kind: 'run', query }
}

const SAVE_LABEL_MAX = 120

export type ParsedSaveSlash = { kind: 'run'; customLabel: string | null }

export function saveSlashUsageLines(): string {
  return [
    'Usage: `/save` or `/save <name>`: adds a row to **Saved** (same Supabase flow as the data panel).',
    '• **ZIP loaded** saves that market (optional name replaces the default place label).',
    '• **County / metro / city loaded** saves the area (optional name; reopen uses your sidebar search text when set). NYC boroughs also work when relevant.',
    '• **Otherwise** saves the **current map center** as a bookmark (optional name; default label uses rounded coordinates).',
    '• Requires Auth (enable **Anonymous** sign-ins in Supabase if you see a sign-in error).',
  ].join('\n')
}

/** Non-`null` when the line is `/save` with optional label after whitespace. */
export function parseSaveSlashCommand(trimmed: string): ParsedSaveSlash | null {
  const m = trimmed.match(/^\/save(?:\s+(.*))?\s*$/i)
  if (!m) return null
  let rest = (m[1] ?? '').trim()
  if (rest.length > SAVE_LABEL_MAX) rest = rest.slice(0, SAVE_LABEL_MAX)
  return { kind: 'run', customLabel: rest.length > 0 ? rest : null }
}

export type ParsedLayersSlash =
  | { kind: 'run'; layers: Partial<Record<SlashLayerKey, true>> }
  | { kind: 'usage' }
  | { kind: 'bad_arg'; message: string }

export function parseLayersSlashCommand(trimmed: string): ParsedLayersSlash | null {
  if (/^\/layers\s*$/i.test(trimmed)) return { kind: 'usage' }
  if (/^\/layers\s+[^:]/i.test(trimmed)) {
    return {
      kind: 'bad_arg',
      message:
        'Use a colon after `layers`: `/layers:rent,permits`, not a space before the first name.',
    }
  }
  const m = trimmed.match(/^\/layers:\s*(.*)$/i)
  if (!m) {
    if (/^\/layers\b/i.test(trimmed)) {
      return {
        kind: 'bad_arg',
        message: 'Missing colon. Example: `/layers:transit,parcels` or type /help for the full list.',
      }
    }
    return null
  }
  const inner = (m[1] ?? '').trim()
  if (!inner) return { kind: 'usage' }
  const parts = inner
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (!parts.length) return { kind: 'usage' }
  const unknown: string[] = []
  const resolved = new Set<SlashLayerKey>()
  for (const p of parts) {
    const k = normalizeLayerSlashToken(p)
    if (!k) unknown.push(p)
    else resolved.add(k)
  }
  if (unknown.length > 0) {
    return {
      kind: 'bad_arg',
      message: `Unknown layer name(s): ${unknown.map((u) => `“${u}”`).join(', ')}. ${layerSlashValidNamesHint()}`,
    }
  }
  const layers: Partial<Record<SlashLayerKey, true>> = {}
  for (const k of resolved) layers[k] = true
  return { kind: 'run', layers }
}

export type ParsedRestartSlash =
  | { kind: 'run' }
  | { kind: 'prompt' }
  | { kind: 'bad_arg'; message: string }
  | { kind: 'cancel' }

export function parseRestartSlashCommand(trimmed: string): ParsedRestartSlash | null {
  const m = trimmed.match(/^\/restart(?:\s+(.+))?\s*$/i)
  if (!m) return null
  const rest = (m[1] ?? '').trim()
  if (!rest) return { kind: 'prompt' }
  const low = rest.toLowerCase()
  if (low === 'no' || low === 'n' || low === 'abort' || low === 'cancel') return { kind: 'cancel' }
  if (low === 'yes' || low === 'y' || low === 'confirm') return { kind: 'run' }
  return {
    kind: 'bad_arg',
    message: `Expected \`/restart\` alone, then **y** or **n**, or one line \`/restart y\` / \`/restart n\`. Got “${rest}”.`,
  }
}

export function isSlashCommandHandled(trimmed: string): boolean {
  if (/^\/help\b/i.test(trimmed)) return true
  if (parseClearSlashCommand(trimmed)) return true
  if (parseGoSlashCommand(trimmed)) return true
  if (parseExportSlashCommand(trimmed)) return true
  if (parseSaveSlashCommand(trimmed)) return true
  if (parseLayersSlashCommand(trimmed)) return true
  if (parseRestartSlashCommand(trimmed)) return true
  if (parseViewSlashCommand(trimmed)) return true
  if (parseTiltSlashCommand(trimmed)) return true
  if (parseRotateSlashCommand(trimmed)) return true
  return false
}

export function isUnknownSlashOnly(trimmed: string): boolean {
  return trimmed.startsWith('/') && !isSlashCommandHandled(trimmed)
}
