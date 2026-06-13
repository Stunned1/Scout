import { isScoutChartOutput, normalizeScoutChartOutput } from '@/lib/scout-chart-output'
import type { SavedOutputRecord } from '@/lib/saved-charts-store'

/** Cover-page fallback when no notes are provided; the preview editor targets this text for click-to-edit. */
export const COVER_NOTES_PLACEHOLDER =
  'No custom notes were added for this export. The pages that follow keep the saved output title, source prompt, and context metadata so the reader can understand what each item is showing.'

export type SavedOutputPdfRecord = SavedOutputRecord & {
  displayTitle?: string | null
  note?: string | null
}

export interface SavedChartsPdfPayload {
  title: string
  notes: string
  generatedAt: string
  outputs: SavedOutputPdfRecord[]
  charts: Array<{
    id: string
    prompt: string
    marketLabel?: string | null
    savedAt: string
    chart: SavedOutputPdfRecord extends infer R ? R extends { kind: 'chart'; payload: infer P } ? P : never : never
  }>
}

const TITLE_MAX = 120
const NOTES_MAX = 4000
const OUTPUT_COUNT_MAX = 20
const CHART_COUNT_MAX = 12

function clampString(value: string, max: number): string {
  return value.trim().slice(0, max)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeSavedOutputPdfRecord(value: unknown): SavedOutputPdfRecord | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.savedAt !== 'string') {
    return null
  }

  const inferredKind =
    typeof value.kind === 'string'
      ? value.kind
      : isRecord(value.chart) && isScoutChartOutput(value.chart)
        ? 'chart'
        : null
  if (!inferredKind) return null

  const marketLabel = typeof value.marketLabel === 'string' ? clampString(value.marketLabel, 160) : null
  const prompt = typeof value.prompt === 'string' ? clampString(value.prompt, 240) : null
  const displayTitle = typeof value.displayTitle === 'string' ? clampString(value.displayTitle, 160) || null : null
  const note = typeof value.note === 'string' ? clampString(value.note, 600) || null : null
  const overrides = { displayTitle, note }

  if (inferredKind === 'chart') {
    const payload = isRecord(value.payload) ? value.payload : isRecord(value.chart) ? value.chart : null
    if (!prompt || !payload || !isScoutChartOutput(payload)) return null
    return {
      ...overrides,
      id: value.id,
      kind: 'chart',
      prompt,
      marketLabel,
      savedAt: value.savedAt,
      payload: normalizeScoutChartOutput(payload),
    }
  }

  if (inferredKind === 'stat_card') {
    if (!prompt || !isRecord(value.payload) || typeof value.payload.title !== 'string' || !Array.isArray(value.payload.stats)) {
      return null
    }
    const stats = value.payload.stats.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.label !== 'string' || typeof entry.value !== 'string') return []
      return [
        {
          label: clampString(entry.label, 120),
          value: clampString(entry.value, 120),
          sublabel: typeof entry.sublabel === 'string' ? clampString(entry.sublabel, 160) : null,
        },
      ]
    })
    if (stats.length !== value.payload.stats.length) return null
    return {
      ...overrides,
      id: value.id,
      kind: 'stat_card',
      prompt,
      marketLabel,
      savedAt: value.savedAt,
      payload: {
        title: clampString(value.payload.title, 160),
        summary: typeof value.payload.summary === 'string' ? clampString(value.payload.summary, 400) : null,
        stats,
      },
    }
  }

  if (inferredKind === 'permit_detail') {
    if (
      !isRecord(value.payload) ||
      typeof value.payload.title !== 'string' ||
      typeof value.payload.permitLabel !== 'string' ||
      typeof value.payload.sourceKind !== 'string' ||
      typeof value.payload.sourceName !== 'string' ||
      typeof value.payload.addressOrPlace !== 'string' ||
      typeof value.payload.categoryLabel !== 'string' ||
      !Array.isArray(value.payload.stats)
    ) {
      return null
    }
    const stats = value.payload.stats.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.label !== 'string' || typeof entry.value !== 'string') return []
      return [
        {
          label: clampString(entry.label, 120),
          value: clampString(entry.value, 120),
          sublabel: typeof entry.sublabel === 'string' ? clampString(entry.sublabel, 160) : null,
        },
      ]
    })
    if (stats.length !== value.payload.stats.length) return null
    return {
      ...overrides,
      id: value.id,
      kind: 'permit_detail',
      prompt,
      marketLabel,
      savedAt: value.savedAt,
      payload: {
        title: clampString(value.payload.title, 160),
        permitLabel: clampString(value.payload.permitLabel, 160),
        sourceKind: clampString(value.payload.sourceKind, 80),
        sourceName: clampString(value.payload.sourceName, 160),
        addressOrPlace: clampString(value.payload.addressOrPlace, 160),
        categoryLabel: clampString(value.payload.categoryLabel, 120),
        dateLabel: typeof value.payload.dateLabel === 'string' ? clampString(value.payload.dateLabel, 120) : null,
        sourceUrl: typeof value.payload.sourceUrl === 'string' ? clampString(value.payload.sourceUrl, 400) : null,
        coordinates:
          isRecord(value.payload.coordinates) &&
          typeof value.payload.coordinates.lat === 'number' &&
          typeof value.payload.coordinates.lng === 'number'
            ? { lat: value.payload.coordinates.lat, lng: value.payload.coordinates.lng }
            : null,
        stats,
      },
    }
  }

  if (inferredKind === 'places_context') {
    if (
      !isRecord(value.payload) ||
      typeof value.payload.siteLabel !== 'string' ||
      typeof value.payload.lat !== 'number' ||
      typeof value.payload.lng !== 'number' ||
      typeof value.payload.radiusMeters !== 'number' ||
      typeof value.payload.summary !== 'string' ||
      !Array.isArray(value.payload.countsByCategory) ||
      !Array.isArray(value.payload.topPlaces)
    ) {
      return null
    }
    const countsByCategory = value.payload.countsByCategory.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.category !== 'string' || typeof entry.label !== 'string' || typeof entry.count !== 'number') return []
      return [{ category: entry.category, label: entry.label, count: entry.count }]
    })
    const topPlaces = value.payload.topPlaces.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.categoryLabel !== 'string') return []
      return [{
        name: entry.name,
        categoryLabel: entry.categoryLabel,
        distanceMeters: typeof entry.distanceMeters === 'number' ? entry.distanceMeters : undefined,
      }]
    })
    if (countsByCategory.length !== value.payload.countsByCategory.length || topPlaces.length !== value.payload.topPlaces.length) return null
    return {
      ...overrides,
      id: value.id,
      kind: 'places_context',
      prompt,
      marketLabel,
      savedAt: value.savedAt,
      payload: {
        siteLabel: clampString(value.payload.siteLabel, 160),
        lat: value.payload.lat,
        lng: value.payload.lng,
        radiusMeters: value.payload.radiusMeters,
        summary: clampString(value.payload.summary, 400),
        countsByCategory,
        topPlaces,
      },
    }
  }

  if (inferredKind === 'uploaded_pin') {
    if (
      !isRecord(value.payload) ||
      typeof value.payload.siteLabel !== 'string' ||
      typeof value.payload.lat !== 'number' ||
      typeof value.payload.lng !== 'number' ||
      !isRecord(value.payload.rowPreview)
    ) {
      return null
    }
    return {
      ...overrides,
      id: value.id,
      kind: 'uploaded_pin',
      prompt,
      marketLabel,
      savedAt: value.savedAt,
      payload: {
        siteLabel: clampString(value.payload.siteLabel, 160),
        lat: value.payload.lat,
        lng: value.payload.lng,
        sourceLabel: typeof value.payload.sourceLabel === 'string' ? clampString(value.payload.sourceLabel, 160) : null,
        rowPreview: value.payload.rowPreview,
      },
    }
  }

  return null
}

export function normalizeSavedChartsPdfPayload(value: unknown): SavedChartsPdfPayload | null {
  if (!isRecord(value)) return null
  if (typeof value.title !== 'string') {
    return null
  }

  const isLegacyChartsPayload = !Array.isArray(value.outputs) && Array.isArray(value.charts)
  const records = Array.isArray(value.outputs) ? value.outputs : isLegacyChartsPayload ? value.charts : null
  if (!records || records.length === 0) return null
  if (isLegacyChartsPayload ? records.length > CHART_COUNT_MAX : records.length > OUTPUT_COUNT_MAX) return null

  const outputs = records.flatMap((record) => {
    const normalized = normalizeSavedOutputPdfRecord(record)
    return normalized ? [normalized] : []
  })
  if (outputs.length !== records.length) return null

  const title = clampString(value.title, TITLE_MAX)
  if (!title) return null

  return {
    title,
    notes: typeof value.notes === 'string' ? clampString(value.notes, NOTES_MAX) : '',
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : new Date().toISOString(),
    outputs,
    charts: outputs.flatMap((output) =>
      output.kind === 'chart'
        ? [
            {
              id: output.id,
              prompt: output.prompt,
              marketLabel: output.marketLabel ?? null,
              savedAt: output.savedAt,
              chart: output.payload,
            },
          ]
        : []
    ),
  }
}
