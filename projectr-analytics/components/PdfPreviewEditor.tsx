'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * An editable region of the generated PDF. The preview locates `matchTexts`
 * (defaults to `value`) in each page's text layer and overlays a click-to-edit
 * hotspot; committing calls `onCommit`, which regenerates the PDF upstream.
 */
export interface PdfEditableField {
  id: string
  label: string
  value: string
  matchTexts?: string[]
  multiline?: boolean
  maxLength?: number
  onCommit: (next: string) => void
}

interface PageHotspot {
  fieldId: string
  left: number
  top: number
  width: number
  height: number
}

interface RenderedPage {
  pageNumber: number
  cssWidth: number
  cssHeight: number
  canvas: HTMLCanvasElement
  hotspots: PageHotspot[]
}

interface EditingState {
  fieldId: string
  pageNumber: number
  rect: PageHotspot
  draft: string
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

function itemMatchesField(normItem: string, field: PdfEditableField): boolean {
  const targets = (field.matchTexts ?? [field.value]).map(normalizeText).filter((t) => t.length >= 3)
  return targets.some((target) => target.includes(normItem) || normItem.includes(target))
}

function mergeHotspots(raw: PageHotspot[]): PageHotspot[] {
  const byField = new Map<string, PageHotspot>()
  for (const spot of raw) {
    const current = byField.get(spot.fieldId)
    if (!current) {
      byField.set(spot.fieldId, { ...spot })
      continue
    }
    const right = Math.max(current.left + current.width, spot.left + spot.width)
    const bottom = Math.max(current.top + current.height, spot.top + spot.height)
    current.left = Math.min(current.left, spot.left)
    current.top = Math.min(current.top, spot.top)
    current.width = right - current.left
    current.height = bottom - current.top
  }
  return [...byField.values()]
}

export default function PdfPreviewEditor({
  data,
  fields,
}: {
  data: ArrayBuffer | null
  fields: PdfEditableField[]
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const fieldsRef = useRef(fields)
  fieldsRef.current = fields

  const [containerWidth, setContainerWidth] = useState(0)
  const [pages, setPages] = useState<RenderedPage[]>([])
  const [editing, setEditing] = useState<EditingState | null>(null)
  const [renderError, setRenderError] = useState<string | null>(null)

  // Re-locate hotspots only when the text being matched actually changes.
  const fieldsMatchKey = useMemo(
    () => JSON.stringify(fields.map((field) => [field.id, field.matchTexts ?? [field.value]])),
    [fields]
  )

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width) setContainerWidth(width)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!data || containerWidth <= 0) {
      if (!data) {
        setPages([])
        setEditing(null)
      }
      return
    }

    let cancelled = false
    ;(async () => {
      const pdfjs = await import('pdfjs-dist')
      // Served from public/ (copied from pdfjs-dist/build); bundler URL resolution breaks under Turbopack.
      if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
      }

      // pdf.js transfers the buffer to its worker, so hand it a copy.
      const loadingTask = pdfjs.getDocument({ data: data.slice(0) })
      const doc = await loadingTask.promise
      try {
        if (cancelled) return

        const pageGutter = 32
        const cssWidth = Math.max(containerWidth - pageGutter, 320)
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const next: RenderedPage[] = []

        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
          if (cancelled) return
          const page = await doc.getPage(pageNumber)
          const baseViewport = page.getViewport({ scale: 1 })
          const scale = cssWidth / baseViewport.width
          const renderViewport = page.getViewport({ scale: scale * dpr })
          const cssViewport = page.getViewport({ scale })

          const canvas = document.createElement('canvas')
          canvas.width = Math.floor(renderViewport.width)
          canvas.height = Math.floor(renderViewport.height)
          await page.render({ canvas, viewport: renderViewport }).promise

          // page.getTextContent() async-iterates a ReadableStream internally, which Safari
          // doesn't support — drain the stream with an explicit reader instead.
          const textItems: Array<{ str: string; transform: number[]; width: number }> = []
          const textReader = page.streamTextContent().getReader()
          for (;;) {
            const { value, done } = await textReader.read()
            if (done) break
            for (const item of value.items) {
              if ('str' in item && typeof item.str === 'string') {
                textItems.push({ str: item.str, transform: item.transform, width: item.width })
              }
            }
          }

          const rawHotspots: PageHotspot[] = []
          for (const item of textItems) {
            const normItem = normalizeText(item.str)
            if (normItem.length < 3) continue
            const field = fieldsRef.current.find((candidate) => itemMatchesField(normItem, candidate))
            if (!field) continue
            const tx = pdfjs.Util.transform(cssViewport.transform, item.transform)
            const height = Math.hypot(tx[2], tx[3])
            rawHotspots.push({
              fieldId: field.id,
              left: tx[4],
              top: tx[5] - height,
              width: item.width * scale,
              height,
            })
          }

          next.push({
            pageNumber,
            cssWidth: cssViewport.width,
            cssHeight: cssViewport.height,
            canvas,
            hotspots: mergeHotspots(rawHotspots),
          })
        }

        if (!cancelled) {
          setPages(next)
          setRenderError(null)
        }
      } finally {
        void loadingTask.destroy()
      }
    })().catch((cause) => {
      console.error('PDF preview render failed:', cause)
      if (!cancelled) setRenderError('Could not render the PDF preview in the browser.')
    })

    return () => {
      cancelled = true
    }
    // fieldsMatchKey stands in for `fields`; hotspot matching reads fieldsRef at run time.
  }, [data, containerWidth, fieldsMatchKey])

  function startEditing(pageNumber: number, rect: PageHotspot) {
    const field = fieldsRef.current.find((candidate) => candidate.id === rect.fieldId)
    if (!field) return
    setEditing({ fieldId: rect.fieldId, pageNumber, rect, draft: field.value })
  }

  function commitEditing() {
    if (!editing) return
    const field = fieldsRef.current.find((candidate) => candidate.id === editing.fieldId)
    setEditing(null)
    if (field && editing.draft !== field.value) field.onCommit(editing.draft)
  }

  return (
    <div ref={containerRef} className="h-full min-h-0 w-full overflow-y-auto">
      {renderError ? (
        <div className="flex h-full items-center justify-center p-8 text-center text-sm text-destructive">
          {renderError}
        </div>
      ) : pages.length === 0 ? (
        <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
          Building the PDF preview…
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 px-4 py-4">
          {pages.map((page) => (
            <div
              key={page.pageNumber}
              className="relative shrink-0 overflow-hidden rounded-md bg-white shadow-lg shadow-black/30"
              style={{ width: page.cssWidth, height: page.cssHeight }}
            >
              <canvas
                ref={(element) => {
                  if (!element) return
                  element.width = page.canvas.width
                  element.height = page.canvas.height
                  element.getContext('2d')?.drawImage(page.canvas, 0, 0)
                }}
                style={{ width: page.cssWidth, height: page.cssHeight, display: 'block' }}
              />

              {page.hotspots.map((rect) => {
                const isEditing = editing?.pageNumber === page.pageNumber && editing.fieldId === rect.fieldId
                if (isEditing) return null
                const field = fields.find((candidate) => candidate.id === rect.fieldId)
                return (
                  <button
                    key={rect.fieldId}
                    type="button"
                    title={field ? `Edit ${field.label}` : 'Edit'}
                    onClick={() => startEditing(page.pageNumber, rect)}
                    className="absolute cursor-text rounded-sm ring-1 ring-primary/25 transition-colors hover:bg-primary/10 hover:ring-2 hover:ring-primary/60"
                    style={{
                      left: rect.left - 3,
                      top: rect.top - 3,
                      width: rect.width + 6,
                      height: rect.height + 6,
                    }}
                  />
                )
              })}

              {editing && editing.pageNumber === page.pageNumber ? (
                <EditingOverlay
                  editing={editing}
                  pageWidth={page.cssWidth}
                  field={fields.find((candidate) => candidate.id === editing.fieldId)}
                  onDraftChange={(draft) => setEditing((current) => (current ? { ...current, draft } : current))}
                  onCommit={commitEditing}
                  onCancel={() => setEditing(null)}
                />
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function EditingOverlay({
  editing,
  pageWidth,
  field,
  onDraftChange,
  onCommit,
  onCancel,
}: {
  editing: EditingState
  pageWidth: number
  field: PdfEditableField | undefined
  onDraftChange: (draft: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  const multiline = field?.multiline ?? false
  const left = Math.max(editing.rect.left - 6, 8)
  const width = Math.min(Math.max(editing.rect.width + 12, 280), pageWidth - left - 8)
  const sharedClassName =
    'absolute z-10 rounded-md border-2 border-primary bg-white px-2 py-1 text-[13px] leading-snug text-zinc-900 shadow-xl outline-none'
  const sharedStyle = { left, top: editing.rect.top - 6, width }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
      return
    }
    if (event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      onCommit()
    }
  }

  if (multiline) {
    return (
      <textarea
        autoFocus
        value={editing.draft}
        maxLength={field?.maxLength}
        onChange={(event) => onDraftChange(event.target.value)}
        onBlur={onCommit}
        onKeyDown={handleKeyDown}
        rows={Math.min(Math.max(Math.ceil(editing.rect.height / 16), 2), 10)}
        className={`${sharedClassName} resize-y`}
        style={sharedStyle}
        placeholder={field ? `Edit ${field.label} — Esc to cancel, ⌘Enter to apply` : undefined}
      />
    )
  }

  return (
    <input
      autoFocus
      value={editing.draft}
      maxLength={field?.maxLength}
      onChange={(event) => onDraftChange(event.target.value)}
      onBlur={onCommit}
      onKeyDown={handleKeyDown}
      className={sharedClassName}
      style={sharedStyle}
      placeholder={field ? `Edit ${field.label} — Esc to cancel, Enter to apply` : undefined}
    />
  )
}
