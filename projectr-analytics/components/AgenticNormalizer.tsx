'use client'

import { useState, useRef, useCallback } from 'react'
import {
  CalendarDays,
  ChartLine,
  ChevronDown,
  CircleDollarSign,
  FileSpreadsheet,
  FolderOpen,
  MapPin,
  MapPinned,
  Plus,
  TableProperties,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { useClientUploadMarkersStore } from '@/lib/client-upload-markers-store'
import {
  attachImportedMarkerSourceKey,
  getImportedSourceKey,
  mergeImportedReviewMarkerPoints,
} from '@/lib/client-upload-presentation'
import {
  useClientUploadSessionStore,
  type ClientUploadSourcePart,
  type ClientUploadVisualizationMode,
  type ClientUploadWorkflowStatus,
} from '@/lib/client-upload-session-store'
import {
  buildClientUploadWorkingRowsKey,
  collectClientUploadWorkingRowsKeys,
  deleteClientUploadWorkingRowsMany,
  putClientUploadWorkingRows,
} from '@/lib/client-upload-working-rows'
import type {
  ClientNormalizeApiResult,
  ClientNormalizeMarkerPoint,
  NormalizerIngestPayload,
} from '@/lib/normalize-client-types'
import type { UploadParseResult } from '@/lib/upload/types'

const MAX_FILES_PER_DROP = 8
type NormalizerStage = 'idle' | 'reviewing' | 'reviewed' | 'importing' | 'imported'

const BUCKET_COLORS: Record<string, string> = {
  GEOSPATIAL: '#D76B3D',
  TEMPORAL: '#60a5fa',
  TABULAR: '#a3a3a3',
}

const BUCKET_ICONS: Record<string, LucideIcon> = {
  GEOSPATIAL: MapPinned,
  TEMPORAL: ChartLine,
  TABULAR: TableProperties,
}

const VISUAL_LABELS: Record<string, string> = {
  HEATMAP: 'Heatmap Layer',
  MARKER: '3D pins (map)',
  POLYGON: 'Polygon Fill',
  TIME_SERIES: 'Line Chart',
  TABULAR: 'Data Grid',
}

const MAPABILITY_LABELS: Record<string, string> = {
  map_ready: 'Ready for map',
  map_normalizable: 'Needs map normalization',
  non_map_visualizable: 'Sidebar or chart',
  unusable: 'Unusable',
}

const FALLBACK_LABELS: Record<string, string> = {
  map_layer: 'Map layer',
  raw_table: 'Raw table',
  time_series_chart: 'Time-series chart',
  bar_chart: 'Bar chart',
  summary_cards: 'Summary cards',
  table_then_chart: 'Table first',
  none: 'No safe fallback',
}

function mergeMarkerPoints(lists: ClientNormalizeMarkerPoint[][]): ClientNormalizeMarkerPoint[] {
  const seen = new Set<string>()
  const out: ClientNormalizeMarkerPoint[] = []
  for (const list of lists) {
    for (const m of list) {
      const key = `${m.source_key ?? 'source'}|${m.lat.toFixed(5)}|${m.lng.toFixed(5)}|${m.label}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(m)
    }
  }
  return out
}

function filterCsvFiles(files: FileList | File[]): File[] {
  const arr = Array.from(files)
  return arr
    .filter((f) => f.name.endsWith('.csv') || f.name.endsWith('.txt'))
    .slice(0, MAX_FILES_PER_DROP)
}

interface AgenticNormalizerProps {
  currentZip?: string | null
  /** Called after markers + session stores are updated (map fly / panel are left to the host page). */
  onIngested?: (payload: NormalizerIngestPayload) => void
}

export default function AgenticNormalizer({ currentZip, onIngested }: AgenticNormalizerProps) {
  const setMarkers = useClientUploadMarkersStore((s) => s.setMarkers)
  const setSession = useClientUploadSessionStore((s) => s.setSession)

  const [dragging, setDragging] = useState(false)
  const [stage, setStage] = useState<NormalizerStage>('idle')
  const [results, setResults] = useState<ClientNormalizeApiResult[]>([])
  const [reviewFiles, setReviewFiles] = useState<File[]>([])
  const [reviewParses, setReviewParses] = useState<UploadParseResult[]>([])
  const [resultNames, setResultNames] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [fileLabel, setFileLabel] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const loading = stage === 'reviewing' || stage === 'importing'

  const requestNormalize = useCallback(
    async (
      file: File,
      mode: 'review' | 'import',
      reviewed?: ClientNormalizeApiResult | null
    ): Promise<ClientNormalizeApiResult> => {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('mode', mode)
      if (currentZip) formData.append('zip', currentZip)
      if (mode === 'import' && reviewed?.review_fingerprint && reviewed?.triage) {
        formData.append('review_fingerprint', reviewed.review_fingerprint)
        formData.append('reviewed_triage', JSON.stringify(reviewed.triage))
      }

      const res = await fetch('/api/normalize', { method: 'POST', body: formData })
      const data = (await res.json()) as ClientNormalizeApiResult & { error?: string }
      if (!res.ok || data.error) {
        throw new Error(data.error ?? `Normalize failed for ${file.name}`)
      }
      return data
    },
    [currentZip]
  )

  const persistImportedSession = useCallback(
    async (
      list: File[],
      normalized: ClientNormalizeApiResult[],
      parsedFiles: UploadParseResult[]
    ) => {
      const previousSession = useClientUploadSessionStore.getState().session
      const previousWorkingRowsKeys = collectClientUploadWorkingRowsKeys(previousSession)
      const ingestedAt = new Date().toISOString()

      const sources: ClientUploadSourcePart[] = await Promise.all(
        normalized.map(async (data, i) => {
          const fileName = list[i]?.name ?? null
          const sourceKey = getImportedSourceKey({ fileName } as ClientUploadSourcePart, i)
          const pts = attachImportedMarkerSourceKey(data.marker_points, sourceKey)
          const workingRows = parsedFiles[i]?.rows ?? []
          const workingRowsKey = buildClientUploadWorkingRowsKey(ingestedAt, i, fileName)
          let rowStorageWarning: string | null = null

          try {
            await putClientUploadWorkingRows(workingRowsKey, workingRows)
          } catch {
            rowStorageWarning =
              'Full imported rows are available in this tab, but durable browser storage was unavailable, so reloading may fall back to preview rows only.'
          }

          const workflowStatus: ClientUploadWorkflowStatus =
            pts.length > 0
              ? 'mapped'
              : data.triage.mapability_classification === 'unusable'
                ? 'errored'
                : 'sidebar_only'
          const visualizationMode: ClientUploadVisualizationMode =
            pts.length > 0
              ? 'map'
              : data.triage.fallback_visualization === 'time_series_chart' ||
                  data.triage.fallback_visualization === 'bar_chart'
                ? 'chart'
                : 'table'
          const inferredMapEligible =
            data.triage.mapability_classification === 'map_ready' ||
            data.triage.mapability_classification === 'map_normalizable'
          const persistenceWarning = [data.persistence_warning, rowStorageWarning].filter(Boolean).join(' ') || null

          return {
            fileName,
            triage: data.triage,
            rowsIngested: data.rows_ingested,
            previewRows: data.preview_rows ?? [],
            workingRows,
            workingRowsKey: rowStorageWarning ? null : workingRowsKey,
            parseSummary: data.parse_summary
              ? {
                  file: data.parse_summary.file,
                  headers: data.parse_summary.headers,
                  sampleRows: data.parse_summary.sample_rows,
                }
              : undefined,
            rawTable: data.raw_table,
            markerPoints: pts,
            markerCount: pts.length,
            mapPinsActive: pts.length > 0,
            mapEligible: data.map_eligible === true || inferredMapEligible,
            workflowStatus,
            visualizationMode,
            persistenceWarning,
            normalization: {
              status:
                pts.length > 0 && data.triage.mapability_classification === 'map_normalizable'
                  ? 'resolved'
                  : 'idle',
              attemptedCount: 0,
              resolvedCount: pts.length,
              failedCount: 0,
              lastRunAt: pts.length > 0 ? new Date().toISOString() : null,
              message:
                pts.length > 0 && data.triage.mapability_classification === 'map_normalizable'
                  ? `Resolved ${pts.length.toLocaleString()} row${pts.length === 1 ? '' : 's'} for map rendering during import.`
                  : null,
            },
          }
        })
      )
      const merged = mergeMarkerPoints(sources.map((source) => source.markerPoints ?? []))
      const hasPins = merged.length > 0

      const nextWorkingRowsKeys = sources
        .map((source) => source.workingRowsKey?.trim() ?? '')
        .filter((key): key is string => key.length > 0)
      const staleWorkingRowsKeys = previousWorkingRowsKeys.filter((key) => !nextWorkingRowsKeys.includes(key))
      if (staleWorkingRowsKeys.length > 0) {
        void deleteClientUploadWorkingRowsMany(staleWorkingRowsKeys)
      }

      setMarkers(hasPins ? merged : null)
      setSession({
        ingestedAt,
        sources,
      })
      onIngested?.({ results: normalized, mergedMarkerPoints: merged })
    },
    [onIngested, setMarkers, setSession]
  )

  const processFiles = useCallback(
    async (files: File[]) => {
      const append = stage === 'reviewed' && reviewFiles.length > 0
      const remaining = MAX_FILES_PER_DROP - (append ? reviewFiles.length : 0)
      if (remaining <= 0) {
        setError(`File limit reached (${MAX_FILES_PER_DROP} per review)`)
        return
      }
      const list = filterCsvFiles(files).slice(0, remaining)
      if (list.length === 0) {
        setError('Add at least one .csv or .txt file')
        return
      }

      setStage('reviewing')
      setError(null)
      if (!append) {
        setResults([])
        setReviewFiles([])
        setReviewParses([])
        setResultNames([])
      }
      setFileLabel(list.length === 1 ? list[0].name : `${list.length} files`)

      try {
        const reviewed: ClientNormalizeApiResult[] = []
        const parsed: UploadParseResult[] = []
        const { parseUploadFile } = await import('@/lib/upload')
        for (const file of list) {
          const [reviewedResult, parsedResult] = await Promise.all([
            requestNormalize(file, 'review'),
            parseUploadFile(file),
          ])
          reviewed.push(reviewedResult)
          parsed.push(parsedResult)
        }
        const names = list.map((f) => f.name)
        setResults((prev) => (append ? [...prev, ...reviewed] : reviewed))
        setReviewFiles((prev) => (append ? [...prev, ...list] : list))
        setReviewParses((prev) => (append ? [...prev, ...parsed] : parsed))
        setResultNames((prev) => (append ? [...prev, ...names] : names))
        setStage('reviewed')
      } catch (err) {
        setStage(append ? 'reviewed' : 'idle')
        setError(err instanceof Error ? err.message : 'Failed to review file(s)')
      }
    },
    [requestNormalize, reviewFiles.length, stage]
  )

  /** Edits flow into import: the reviewed triage is sent back to /api/normalize on commit. */
  const updateTriageColumn = useCallback(
    (index: number, key: 'geo_column' | 'value_column' | 'date_column', value: string | null) => {
      setResults((prev) =>
        prev.map((result, i) =>
          i === index ? { ...result, triage: { ...result.triage, [key]: value } } : result
        )
      )
    },
    []
  )

  const importReviewedFiles = useCallback(async () => {
    if (reviewFiles.length === 0) return

    setStage('importing')
    setError(null)
    try {
      const committed: ClientNormalizeApiResult[] = []
      for (const [index, file] of reviewFiles.entries()) {
        committed.push(await requestNormalize(file, 'import', results[index] ?? null))
      }
      await persistImportedSession(reviewFiles, committed, reviewParses)
      setResults(committed)
      setStage('imported')
    } catch (err) {
      setStage('reviewed')
      setError(err instanceof Error ? err.message : 'Failed to import file(s)')
    }
  }, [persistImportedSession, requestNormalize, results, reviewFiles, reviewParses])

  const clearReview = useCallback(() => {
    setStage('idle')
    setError(null)
    setResults([])
    setReviewFiles([])
    setReviewParses([])
    setResultNames([])
    setFileLabel(null)
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      if (e.dataTransfer.files?.length) processFiles(Array.from(e.dataTransfer.files))
    },
    [processFiles]
  )

  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const fl = e.target.files
      if (fl?.length) processFiles(Array.from(fl))
      e.target.value = ''
    },
    [processFiles]
  )

  const hasResults = results.length > 0
  const totalRows = results.reduce((sum, result) => sum + result.rows_ingested, 0)
  const totalPins = hasResults ? mergeImportedReviewMarkerPoints(results, resultNames).length : 0

  return (
    <div className="@container flex flex-col gap-3">
      <input
        ref={fileRef}
        type="file"
        accept=".csv,.txt"
        multiple
        className="hidden"
        onChange={onFileChange}
      />

      {hasResults ? (
        <div
          onDragOver={(e) => {
            e.preventDefault()
            if (!loading) setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            if (loading) {
              e.preventDefault()
              return
            }
            onDrop(e)
          }}
          onClick={() => {
            if (!loading) fileRef.current?.click()
          }}
          className={`flex items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2.5 transition-colors ${
            dragging
              ? 'border-primary bg-primary/10'
              : 'border-white/15 hover:border-white/30 hover:bg-white/3'
          } ${loading ? 'opacity-70' : 'cursor-pointer'}`}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-primary/40 bg-primary/10 text-primary">
              {loading ? (
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              ) : (
                <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              )}
            </span>
            <p className="truncate text-xs text-zinc-300">
              {stage === 'reviewing' ? (
                <>Reviewing {fileLabel}…</>
              ) : stage === 'importing' ? (
                <>Importing reviewed file(s)…</>
              ) : (
                <>
                  Drop more CSVs or <span className="font-medium text-primary">browse</span>
                </>
              )}
            </p>
          </div>
          <p className="shrink-0 font-mono text-[10px] tracking-wide text-zinc-500">
            {results.length} of {MAX_FILES_PER_DROP} files
          </p>
        </div>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileRef.current?.click()}
          className={`relative cursor-pointer rounded-lg border-2 border-dashed p-6 text-center transition-all ${
            dragging
              ? 'border-primary bg-primary/10'
              : 'border-white/15 hover:border-white/30 hover:bg-white/3'
          }`}
        >
          {loading ? (
            <div className="flex flex-col items-center gap-2">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <p className="text-xs text-zinc-400">Reviewing import…</p>
              <p className="text-[10px] text-zinc-600">{fileLabel}</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <FolderOpen className="h-8 w-8 text-zinc-300" strokeWidth={1.75} aria-hidden />
              <p className="text-xs font-medium text-white">Drop CSV(s) here or click to review</p>
              <p className="text-[10px] text-zinc-500">
                Up to {MAX_FILES_PER_DROP} files at once. Review happens before import so you can confirm mapability,
                fallback mode, and the chosen rendering path before anything is committed.
              </p>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-800/50 bg-red-950/50 px-3 py-2 text-xs text-red-400">{error}</div>
      )}

      {hasResults && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/4 px-4 py-3">
            <div className="min-w-0">
              <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-primary">
                {stage === 'imported' ? 'Import complete' : 'Import review'}
              </p>
              <p className="mt-0.5 text-xs text-zinc-400">
                <span className="font-semibold text-zinc-100">
                  {results.length} file{results.length === 1 ? '' : 's'} {stage === 'imported' ? 'imported' : 'ready'}
                </span>{' '}
                · {totalRows.toLocaleString()} rows
                {totalPins > 0 && <> · {totalPins.toLocaleString()} map pin{totalPins === 1 ? '' : 's'}</>}
                {stage !== 'imported' && <> · nothing committed yet</>}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {stage === 'reviewed' && (
                <>
                  <button
                    type="button"
                    onClick={clearReview}
                    className="rounded-md border border-white/12 px-3 py-1.5 text-[11px] font-medium text-zinc-300 transition-colors hover:border-white/25 hover:text-white"
                  >
                    Clear review
                  </button>
                  <button
                    type="button"
                    onClick={() => void importReviewedFiles()}
                    className="rounded-md bg-primary px-3 py-1.5 text-[11px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
                  >
                    Import reviewed files →
                  </button>
                </>
              )}
              {stage === 'imported' && (
                <span className="rounded-md border border-emerald-800/40 bg-emerald-950/30 px-3 py-1.5 text-[11px] font-medium text-emerald-300">
                  Imported
                </span>
              )}
            </div>
          </div>

          {results.map((result, idx) => {
            const BucketIcon = BUCKET_ICONS[result.triage.bucket] ?? FileSpreadsheet
            const bucketColor = BUCKET_COLORS[result.triage.bucket] ?? '#a3a3a3'
            const confidencePct = Math.round(result.triage.confidence * 100)
            const headers = result.parse_summary?.headers ?? []
            const mappedColumns = new Set(
              [result.triage.geo_column, result.triage.value_column, result.triage.date_column].filter(
                (col): col is string => Boolean(col)
              )
            )
            const warning = result.persistence_warning ?? result.triage.warnings[0] ?? null
            const editable = stage === 'reviewed'
            const mappingFields: {
              key: 'geo_column' | 'value_column' | 'date_column'
              label: string
              Icon: LucideIcon
            }[] = [
              { key: 'geo_column', label: 'Geography', Icon: MapPin },
              { key: 'value_column', label: 'Value', Icon: CircleDollarSign },
              { key: 'date_column', label: 'Date', Icon: CalendarDays },
            ]

            return (
              <div key={idx} className="overflow-hidden rounded-xl border border-white/10 bg-white/3">
                <div className="flex items-start gap-3 px-4 pt-4">
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border"
                    style={{ borderColor: `${bucketColor}55`, backgroundColor: `${bucketColor}14`, color: bucketColor }}
                  >
                    <BucketIcon className="h-4.5 w-4.5" strokeWidth={1.75} aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      <span className="font-semibold text-white">{result.triage.metric_name}</span>{' '}
                      <span className="font-mono text-[11px] text-zinc-500">{resultNames[idx]}</span>
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <span
                        className="rounded border px-2 py-0.5 font-mono text-[10px]"
                        style={{ borderColor: `${bucketColor}66`, backgroundColor: `${bucketColor}10`, color: bucketColor }}
                      >
                        {result.triage.bucket} → {VISUAL_LABELS[result.triage.visual_bucket] ?? result.triage.visual_bucket}
                      </span>
                      <span
                        className={`rounded border px-2 py-0.5 font-mono text-[10px] ${
                          result.triage.mapability_classification === 'map_normalizable'
                            ? 'border-amber-700/50 bg-amber-950/30 text-amber-300'
                            : result.triage.mapability_classification === 'unusable'
                              ? 'border-red-800/50 bg-red-950/30 text-red-300'
                              : 'border-white/12 bg-white/4 text-zinc-300'
                        }`}
                      >
                        {MAPABILITY_LABELS[result.triage.mapability_classification] ??
                          result.triage.mapability_classification}
                      </span>
                      <span className="rounded border border-white/12 bg-white/4 px-2 py-0.5 font-mono text-[10px] text-zinc-300">
                        {FALLBACK_LABELS[result.triage.fallback_visualization] ??
                          result.triage.fallback_visualization}{' '}
                        fallback
                      </span>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-semibold text-white">
                      {result.rows_ingested.toLocaleString()} <span className="text-[10px] font-normal text-zinc-500">rows</span>
                    </p>
                    <p className="mt-1.5 font-mono text-[9px] uppercase tracking-widest text-zinc-500">
                      Confidence <span className="text-emerald-400">{confidencePct}%</span>
                    </p>
                    <div className="ml-auto mt-1 h-0.5 w-20 overflow-hidden rounded-full bg-white/10">
                      <div className="h-full rounded-full bg-emerald-400" style={{ width: `${confidencePct}%` }} />
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid border-t border-white/8 @xl:grid-cols-[minmax(0,1fr)_minmax(0,280px)] @xl:divide-x @xl:divide-white/8">
                  <div className="min-w-0 p-4">
                    <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-500">
                      AI read · Gemini
                    </p>
                    <blockquote className="mt-2.5 border-l-2 border-primary/70 pl-3 text-[11px] italic leading-relaxed text-zinc-200">
                      &quot;{result.triage.reasoning}&quot;
                    </blockquote>
                    <p className="mt-2.5 text-[11px] leading-relaxed text-zinc-400">{result.triage.explanation}</p>

                    {headers.length > 0 && (
                      <div className="mt-4">
                        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-500">
                          Detected columns · {headers.length}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {headers.slice(0, 10).map((header) => (
                            <span
                              key={header}
                              className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${
                                mappedColumns.has(header)
                                  ? 'border-primary/50 bg-primary/10 text-primary'
                                  : 'border-white/10 bg-white/4 text-zinc-400'
                              }`}
                            >
                              {header}
                            </span>
                          ))}
                          {headers.length > 10 && (
                            <span className="rounded border border-white/10 bg-white/4 px-1.5 py-0.5 font-mono text-[9px] text-zinc-500">
                              +{headers.length - 10} more
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 border-t border-white/8 p-4 @xl:border-t-0">
                    <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-500">
                      Column mapping
                    </p>
                    <div className="mt-2.5 space-y-3">
                      {mappingFields.map(({ key, label, Icon }) => {
                        const current = result.triage[key]
                        const options = current && !headers.includes(current) ? [current, ...headers] : headers
                        return (
                          <div key={key}>
                            <label className="flex items-center gap-1 text-[10px] font-medium text-zinc-400">
                              <Icon className="h-3 w-3 text-primary/80" strokeWidth={1.75} aria-hidden />
                              {label}
                            </label>
                            <div className="relative mt-1">
                              <select
                                value={current ?? ''}
                                disabled={!editable}
                                onChange={(e) => updateTriageColumn(idx, key, e.target.value || null)}
                                className="w-full appearance-none truncate rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 pr-7 font-mono text-[11px] text-zinc-100 transition-colors focus:border-primary/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                <option value="">— none —</option>
                                {options.map((header) => (
                                  <option key={header} value={header}>
                                    {header}
                                  </option>
                                ))}
                              </select>
                              <ChevronDown
                                className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500"
                                aria-hidden
                              />
                            </div>
                          </div>
                        )
                      })}
                    </div>

                    {warning && (
                      <div className="mt-3 flex items-start gap-1.5 rounded-md border border-amber-800/40 bg-amber-950/20 px-2.5 py-2 text-[10px] leading-relaxed text-amber-200">
                        <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden />
                        <span>{warning}</span>
                      </div>
                    )}

                    <div className="mt-3 space-y-1.5">
                      {(result.marker_points?.length ?? 0) > 0 && (
                        <p className="text-[10px] leading-relaxed text-zinc-400">
                          <span className="font-semibold text-primary">
                            {result.marker_points!.length.toLocaleString()} pin{result.marker_points!.length === 1 ? '' : 's'}
                          </span>{' '}
                          will appear on the <span className="text-primary">Client</span> layer
                        </p>
                      )}
                      {result.triage.mapability_classification === 'map_normalizable' &&
                        (result.marker_points?.length ?? 0) === 0 && (
                          <p className="text-[10px] leading-relaxed text-amber-300">
                            {stage === 'reviewed' ? 'Will import' : 'Imported'} with a table-first fallback while map
                            normalization remains unresolved
                          </p>
                        )}
                      {result.triage.bucket === 'TEMPORAL' && (
                        <p className="text-[10px] leading-relaxed text-blue-400">
                          {stage === 'reviewed' ? 'Routes to' : 'Available in'} the{' '}
                          <span className="font-semibold">Imported Data</span> chart/table workflow
                        </p>
                      )}
                      {result.triage.bucket === 'TABULAR' && (
                        <p className="text-[10px] leading-relaxed text-zinc-400">
                          {stage === 'reviewed' ? 'Routes to' : 'Available in'} the{' '}
                          <span className="font-semibold">Imported Data</span> table workflow
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
