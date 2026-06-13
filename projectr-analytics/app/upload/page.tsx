'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { BookOpen } from 'lucide-react'
import AgenticNormalizer from '@/components/AgenticNormalizer'
import CommandCenterSidebar from '@/components/CommandCenterSidebar'
import { ImportedDataPanel } from '@/components/ImportedDataPanel'
import SitesBootstrap from '@/components/SitesBootstrap'
import {
  collectClientUploadWorkingRowsKeys,
  deleteClientUploadWorkingRowsMany,
} from '@/lib/client-upload-working-rows'
import { useClientUploadMarkersStore } from '@/lib/client-upload-markers-store'
import { aggregateClientUploadSession } from '@/lib/client-upload-session-aggregate'
import { useClientUploadSessionStore } from '@/lib/client-upload-session-store'
import { stashPendingNav } from '@/lib/pending-navigation'
import { cn } from '@/lib/utils'

export default function ClientUploadPage() {
  const router = useRouter()
  const [searchInput, setSearchInput] = useState('')
  const markers = useClientUploadMarkersStore((s) => s.markers)
  const clearMarkers = useClientUploadMarkersStore((s) => s.clearMarkers)
  const clientUploadSession = useClientUploadSessionStore((s) => s.session)
  const clearSession = useClientUploadSessionStore((s) => s.clearSession)
  const clientUploadAgg = aggregateClientUploadSession(clientUploadSession)

  function clearImportedWorkspace() {
    clearMarkers()
    void deleteClientUploadWorkingRowsMany(collectClientUploadWorkingRowsKeys(clientUploadSession))
    clearSession()
  }

  async function handleAnalyzeFromUpload(e: React.FormEvent) {
    e.preventDefault()
    const input = searchInput.trim()
    if (!input) return
    if (/^\d{5}$/.test(input)) stashPendingNav({ type: 'zip', zip: input })
    else stashPendingNav({ type: 'aggregate', query: input })
    router.push('/')
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <SitesBootstrap />
      <CommandCenterSidebar
        searchInput={searchInput}
        setSearchInput={setSearchInput}
        error={null}
        loading={false}
        onAnalyzeSubmit={handleAnalyzeFromUpload}
        activeMarket={null}
        panelOpen={false}
        onTogglePanel={() => router.push('/')}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-muted/20 px-5 py-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-primary">Workspace</p>
            <h1 className="text-base font-semibold tracking-tight text-foreground">Upload Data</h1>
          </div>
          <div className="flex w-full max-w-[min(100%,280px)] shrink-0 items-center justify-end sm:max-w-[280px]">
            <Link
              href="/guide"
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border border-border/90 bg-background px-2.5 py-1.5 text-xs font-medium text-foreground/80 shadow-none transition-colors',
                'hover:border-foreground/20 hover:bg-muted/50 hover:text-foreground',
                'focus-visible:border-foreground/25 focus-visible:ring-1 focus-visible:ring-foreground/15 focus-visible:outline-none'
              )}
            >
              <BookOpen className="h-3.5 w-3.5 text-foreground/50" strokeWidth={1.75} aria-hidden />
              Documentation
            </Link>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto max-w-3xl space-y-6 px-5 py-8 pb-16 sm:px-6">
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-foreground">Upload a file</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Scout reviews each file with Gemini when available, with structural fallback heuristics if needed. Rows
                with coordinates, ZIPs, or resolvable addresses can appear as orange{' '}
                <span className="text-foreground/90">3D client pins</span> on the map when you open{' '}
                <span className="text-foreground/90">Map</span> and enable the <span className="text-foreground/90">Client</span>{' '}
                layer. Datasets that are not map-ready still stay usable here through summary stats, tables, and chart
                fallbacks when the data supports them.
              </p>
            </div>
            <AgenticNormalizer />

            {clientUploadAgg && (
              <section className="space-y-4 rounded-2xl border border-border/80 bg-card/70 p-4 shadow-sm">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary/80">
                      Imported workspace
                    </p>
                    <h3 className="text-sm font-semibold text-foreground">
                      {clientUploadAgg.fileNameLabel ?? 'Last imported dataset'}
                    </h3>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Projectr keeps the interpreted dataset live even when it is not map-ready. Use the panel below to
                      inspect charts, raw rows, or the active map-backed records without depending on the agent loop.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {clientUploadAgg.mapPinsActive ? (
                      <button
                        type="button"
                        onClick={() => router.push('/')}
                        className="rounded-lg border border-primary/35 bg-primary/10 px-3 py-1.5 text-xs text-primary transition-colors hover:bg-primary/20"
                      >
                        Open map
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={clearImportedWorkspace}
                      className="rounded border border-border px-2 py-1.5 text-[10px] text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                    >
                      Clear imported data
                    </button>
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-3">
                  <div className="rounded-xl border border-border/70 bg-background/40 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Files</p>
                    <p className="text-sm font-semibold text-foreground">{clientUploadAgg.sourceCount}</p>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-background/40 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Rows</p>
                    <p className="text-sm font-semibold text-foreground">{clientUploadAgg.rowsIngested.toLocaleString()}</p>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-background/40 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Map pins</p>
                    <p className="text-sm font-semibold text-foreground">{clientUploadAgg.markerCount.toLocaleString()}</p>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-background/40 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Mapped</p>
                    <p className="text-sm font-semibold text-foreground">{clientUploadAgg.statusCounts.mapped}</p>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-background/40 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Sidebar only</p>
                    <p className="text-sm font-semibold text-foreground">{clientUploadAgg.statusCounts.sidebar_only}</p>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-background/40 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Errored</p>
                    <p className="text-sm font-semibold text-foreground">{clientUploadAgg.statusCounts.errored}</p>
                  </div>
                </div>

                <ImportedDataPanel session={clientUploadSession} />
              </section>
            )}

            {markers != null && markers.length > 0 && !clientUploadAgg && (
              <div className="flex flex-col gap-3 rounded-xl border border-border/80 bg-card/80 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{markers.length}</span> pin{markers.length === 1 ? '' : 's'}{' '}
                  ready. Turn on <span className="text-primary">Client</span> on the map
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => router.push('/')}
                    className="rounded-lg border border-primary/35 bg-primary/10 px-3 py-1.5 text-xs text-primary transition-colors hover:bg-primary/20"
                  >
                    Open map
                  </button>
                  <button
                    type="button"
                    onClick={clearMarkers}
                    className="rounded border border-border px-2 py-1.5 text-[10px] text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                  >
                    Clear pins
                  </button>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
