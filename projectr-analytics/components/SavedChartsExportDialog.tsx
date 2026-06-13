'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Pencil } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import PdfPreviewEditor, { type PdfEditableField } from '@/components/PdfPreviewEditor'
import { COVER_NOTES_PLACEHOLDER } from '@/lib/report/saved-charts-export'
import { useSavedChartsStore, type SavedOutputRecord } from '@/lib/saved-charts-store'

const PREVIEW_DEBOUNCE_MS = 700

function formatSavedAt(savedAt: string): string {
  const date = new Date(savedAt)
  if (Number.isNaN(date.getTime())) return 'Saved recently'

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function outputDefaultTitle(output: SavedOutputRecord): string {
  if (output.kind === 'chart' || output.kind === 'stat_card' || output.kind === 'permit_detail') {
    return output.payload.title
  }
  return output.payload.siteLabel
}

function outputKindLabel(output: SavedOutputRecord): string {
  if (output.kind === 'chart') return output.payload.kind === 'line' ? 'Trend chart' : 'Comparison chart'
  if (output.kind === 'stat_card') return 'Stat card'
  if (output.kind === 'places_context') return 'Nearby context'
  if (output.kind === 'permit_detail') return 'Permit detail'
  return 'Site snapshot'
}

interface EditableItem {
  id: string
  included: boolean
  displayTitle: string
  note: string
}

interface SavedChartsExportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  suggestedTitle: string
}

export default function SavedChartsExportDialog({
  open,
  onOpenChange,
  suggestedTitle,
}: SavedChartsExportDialogProps) {
  const outputs = useSavedChartsStore((state) => state.outputs)
  const [items, setItems] = useState<EditableItem[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [title, setTitle] = useState(suggestedTitle)
  const [notes, setNotes] = useState('')
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [previewData, setPreviewData] = useState<ArrayBuffer | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const previewBlobRef = useRef<Blob | null>(null)
  const previewFreshRef = useRef(false)
  const wasOpenRef = useRef(false)

  const outputsById = useMemo(() => new Map(outputs.map((output) => [output.id, output])), [outputs])

  // Initialize on open; merge (keep edits and order) when outputs change while the dialog is open.
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      return
    }
    setItems((current) => {
      const previous = wasOpenRef.current ? new Map(current.map((item) => [item.id, item])) : new Map<string, EditableItem>()
      const kept = wasOpenRef.current
        ? current.filter((item) => outputsById.has(item.id))
        : []
      const appended = outputs
        .filter((output) => !previous.has(output.id))
        .map((output) => ({ id: output.id, included: true, displayTitle: '', note: '' }))
      return [...kept, ...appended]
    })
    if (!wasOpenRef.current) {
      setTitle((current) => current.trim() || suggestedTitle)
      setExpandedId(null)
      setError(null)
    }
    wasOpenRef.current = true
  }, [open, outputs, outputsById, suggestedTitle])

  const exportOutputs = useMemo(() => {
    return items.flatMap((item) => {
      if (!item.included) return []
      const record = outputsById.get(item.id)
      if (!record) return []
      return [
        {
          ...record,
          displayTitle: item.displayTitle.trim() || undefined,
          note: item.note.trim() || undefined,
        },
      ]
    })
  }, [items, outputsById])

  const cleanTitle = title.trim() || suggestedTitle

  // Re-render the actual PDF (same pipeline as the export) whenever the content changes.
  const previewPayloadKey = useMemo(
    () => JSON.stringify({ title: cleanTitle, notes, outputs: exportOutputs }),
    [cleanTitle, notes, exportOutputs]
  )

  useEffect(() => {
    if (!open) return
    previewFreshRef.current = false
    if (exportOutputs.length === 0) {
      setPreviewData(null)
      previewBlobRef.current = null
      setPreviewLoading(false)
      return
    }

    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setPreviewLoading(true)
      try {
        const res = await fetch('/api/report/charts/pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            title: cleanTitle,
            notes,
            generatedAt: new Date().toISOString(),
            outputs: exportOutputs,
          }),
        })

        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          setError(body?.error ?? 'Could not refresh the PDF preview.')
          return
        }

        const blob = await res.blob()
        const buffer = await blob.arrayBuffer()
        if (controller.signal.aborted) return
        previewBlobRef.current = blob
        previewFreshRef.current = true
        setError(null)
        setPreviewData(buffer)
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          setError('Network error while refreshing the PDF preview.')
        }
      } finally {
        if (!controller.signal.aborted) setPreviewLoading(false)
      }
    }, PREVIEW_DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // previewPayloadKey captures title/notes/outputs; listing it keeps the debounce keyed to real changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, previewPayloadKey])

  // Regions of the rendered PDF that can be edited by clicking directly on the preview.
  const pdfFields = useMemo<PdfEditableField[]>(() => {
    const fields: PdfEditableField[] = [
      {
        id: 'report-title',
        label: 'report title',
        value: cleanTitle,
        maxLength: 120,
        onCommit: (next) => setTitle(next),
      },
      {
        id: 'cover-notes',
        label: 'cover notes',
        value: notes,
        matchTexts: [notes.trim() || COVER_NOTES_PLACEHOLDER],
        multiline: true,
        maxLength: 4000,
        onCommit: (next) => setNotes(next),
      },
    ]

    for (const item of items) {
      if (!item.included) continue
      const record = outputsById.get(item.id)
      if (!record) continue
      fields.push({
        id: `title:${item.id}`,
        label: 'section title',
        value: item.displayTitle.trim() || outputDefaultTitle(record),
        maxLength: 160,
        onCommit: (next) => updateItem(item.id, { displayTitle: next }),
      })
      if (item.note.trim()) {
        fields.push({
          id: `note:${item.id}`,
          label: 'section note',
          value: item.note,
          multiline: true,
          maxLength: 600,
          onCommit: (next) => updateItem(item.id, { note: next }),
        })
      }
    }
    return fields
  }, [cleanTitle, notes, items, outputsById])

  function updateItem(id: string, patch: Partial<EditableItem>) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  function moveItem(id: string, direction: -1 | 1) {
    setItems((current) => {
      const index = current.findIndex((item) => item.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  function downloadBlob(blob: Blob) {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${cleanTitle.replace(/[^\w\s-]/g, '').trim().slice(0, 60) || 'Scout-export'}.pdf`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  async function handleExport() {
    setError(null)
    if (exportOutputs.length === 0) {
      setError('Include at least one saved output before exporting.')
      return
    }

    // The preview blob is the exact same PDF; reuse it when it already reflects the latest edits.
    if (previewFreshRef.current && previewBlobRef.current && !previewLoading) {
      downloadBlob(previewBlobRef.current)
      onOpenChange(false)
      return
    }

    setExporting(true)
    try {
      const res = await fetch('/api/report/charts/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: cleanTitle,
          notes,
          generatedAt: new Date().toISOString(),
          outputs: exportOutputs,
        }),
      })

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? 'PDF export failed.')
        return
      }

      downloadBlob(await res.blob())
      onOpenChange(false)
    } catch {
      setError('Network error while building the PDF export.')
    } finally {
      setExporting(false)
    }
  }

  const includedCount = exportOutputs.length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(94vh,1000px)] max-h-[94vh] w-[min(98vw,1560px)] max-w-[min(98vw,1560px)] flex-col overflow-hidden p-0 sm:max-w-[min(98vw,1560px)]"
        showCloseButton
      >
        <DialogHeader className="shrink-0 border-b border-border px-6 py-4 pr-14">
          <DialogTitle>PDF editor</DialogTitle>
          <DialogDescription>
            Edit the report on the left and watch the actual PDF update on the right. What you see is exactly what downloads.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 overflow-hidden lg:grid-cols-[minmax(380px,0.85fr)_minmax(0,1.35fr)]">
          <section className="flex min-h-0 flex-col border-b border-border lg:border-r lg:border-b-0">
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-4 px-6 py-4 pr-7">
                <div>
                  <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-primary">
                    Report title
                  </label>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder={suggestedTitle}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary/50"
                    maxLength={120}
                  />
                </div>

                <div>
                  <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-primary">
                    Cover notes
                  </label>
                  <textarea
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="Add a short plain-English summary for whoever will read this PDF. It appears on the cover page."
                    className="min-h-24 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm leading-relaxed outline-none transition-colors focus:border-primary/50"
                    rows={4}
                    maxLength={4000}
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-primary">Report sections</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {outputs.length === 0
                        ? 'No outputs are saved in this session yet.'
                        : `${includedCount} of ${items.length} sections included`}
                    </p>
                  </div>
                  {items.length > 0 ? (
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() => setItems((current) => current.map((item) => ({ ...item, included: true })))}
                      >
                        Include all
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => setItems((current) => current.map((item) => ({ ...item, included: false })))}
                      >
                        Clear
                      </Button>
                    </div>
                  ) : null}
                </div>

                {items.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border bg-muted/20 p-4 text-sm leading-relaxed text-muted-foreground">
                    Save at least one output first, then run <span className="font-semibold text-foreground">/export</span>.
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {items.map((item, index) => {
                      const record = outputsById.get(item.id)
                      if (!record) return null
                      const expanded = expandedId === item.id
                      const defaultTitle = outputDefaultTitle(record)
                      return (
                        <div
                          key={item.id}
                          className={`rounded-xl border transition-colors ${
                            item.included
                              ? 'border-primary/50 bg-primary/5'
                              : 'border-border/80 bg-card/40 opacity-70'
                          }`}
                        >
                          <div className="flex items-start gap-3 p-3">
                            <Checkbox
                              checked={item.included}
                              onCheckedChange={(value) => updateItem(item.id, { included: value === true })}
                              className="mt-0.5"
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-semibold leading-snug text-foreground">
                                {index + 1}. {item.displayTitle.trim() || defaultTitle}
                              </p>
                              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                                <span className="rounded-full border border-border/80 bg-background/70 px-2 py-0.5">
                                  {outputKindLabel(record)}
                                </span>
                                <span className="py-0.5">{formatSavedAt(record.savedAt)}</span>
                                {record.marketLabel?.trim() ? <span className="py-0.5">Market: {record.marketLabel.trim()}</span> : null}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <Button
                                type="button"
                                size="xs"
                                variant="ghost"
                                className="h-7 w-7 p-0"
                                disabled={index === 0}
                                onClick={() => moveItem(item.id, -1)}
                                aria-label="Move section up"
                              >
                                <ChevronUp className="h-4 w-4" />
                              </Button>
                              <Button
                                type="button"
                                size="xs"
                                variant="ghost"
                                className="h-7 w-7 p-0"
                                disabled={index === items.length - 1}
                                onClick={() => moveItem(item.id, 1)}
                                aria-label="Move section down"
                              >
                                <ChevronDown className="h-4 w-4" />
                              </Button>
                              <Button
                                type="button"
                                size="xs"
                                variant={expanded ? 'secondary' : 'ghost'}
                                className="h-7 w-7 p-0"
                                onClick={() => setExpandedId(expanded ? null : item.id)}
                                aria-label="Edit section title and note"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>

                          {expanded ? (
                            <div className="flex flex-col gap-3 border-t border-border/70 px-3 py-3">
                              <div>
                                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-primary">
                                  Section title
                                </label>
                                <input
                                  value={item.displayTitle}
                                  onChange={(event) => updateItem(item.id, { displayTitle: event.target.value })}
                                  placeholder={defaultTitle}
                                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary/50"
                                  maxLength={160}
                                />
                              </div>
                              <div>
                                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-primary">
                                  Section note
                                </label>
                                <textarea
                                  value={item.note}
                                  onChange={(event) => updateItem(item.id, { note: event.target.value })}
                                  placeholder="Optional analyst note shown on this section's page."
                                  className="min-h-20 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm leading-relaxed outline-none transition-colors focus:border-primary/50"
                                  rows={3}
                                  maxLength={600}
                                />
                              </div>
                            </div>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </ScrollArea>
          </section>

          <section className="relative flex min-h-0 flex-col bg-muted/30">
            {previewData ? (
              <PdfPreviewEditor data={previewData} fields={pdfFields} />
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
                {includedCount === 0
                  ? 'Include at least one section to see the PDF preview.'
                  : 'Building the PDF preview…'}
              </div>
            )}
            {previewLoading ? (
              <div className="pointer-events-none absolute right-4 top-4 rounded-full border border-border bg-background/90 px-3 py-1 text-[11px] font-medium text-muted-foreground shadow-sm">
                Updating preview…
              </div>
            ) : null}
          </section>
        </div>

        <DialogFooter
          className="mx-0 mb-0 shrink-0 rounded-none border-t px-6 py-4 sm:flex-row sm:items-center sm:justify-between"
          showCloseButton={false}
        >
          <div className="min-w-0">
            {error ? (
              <p className="text-xs text-destructive">{error}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                The preview is the real PDF — click highlighted text on it to edit in place. Exporting downloads exactly what you see.
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={handleExport} disabled={exporting || includedCount === 0}>
              {exporting ? 'Building PDF...' : 'Export PDF'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
