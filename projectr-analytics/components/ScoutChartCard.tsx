'use client'

import type { ReactNode } from 'react'
import type { ScoutChartOutput } from '@/lib/scout-chart-output'
import { cn } from '@/lib/utils'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

const URL_PATTERN = /(https?:\/\/[^\s)]+)/g

/** Renders plain text with any http(s) URLs as clickable links (used for citation notes). */
function LinkifiedText({ text }: { text: string }) {
  const segments = text.split(URL_PATTERN)
  return (
    <>
      {segments.map((segment, index) =>
        /^https?:\/\//.test(segment) ? (
          <a
            key={index}
            href={segment}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
          >
            {segment.replace(/^https?:\/\/(www\.)?/, '')}
          </a>
        ) : (
          segment
        )
      )}
    </>
  )
}

function formatValue(value: number, format: ScoutChartOutput['yAxis']['valueFormat']) {
  if (format === 'currency') return `$${Math.round(value).toLocaleString()}`
  if (format === 'percent') return `${value.toFixed(1)}%`
  return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(1)
}

function formatChartValue(
  value: string | number | readonly (string | number)[] | undefined,
  format: ScoutChartOutput['yAxis']['valueFormat']
): string {
  if (Array.isArray(value)) return value.map((entry) => formatChartValue(entry, format)).join(', ')
  if (typeof value === 'number') return formatValue(value, format)
  if (typeof value === 'string') return value
  return ''
}

function toRechartsRows(chart: ScoutChartOutput): Array<Record<string, string | number>> {
  const labels = new Set<string>()
  for (const series of chart.series) {
    for (const point of series.points) labels.add(point.x)
  }

  return [...labels].map((label) => {
    const row: Record<string, string | number> = { [chart.xAxis.key]: label }
    for (const series of chart.series) {
      const point = series.points.find((entry) => entry.x === label)
      if (point) row[series.key] = point.y
    }
    return row
  })
}

export function ScoutChartCard({
  chart,
  actions,
  className,
  showHeader = true,
  showSources = true,
  chartHeightClass = 'h-56',
}: {
  chart: ScoutChartOutput
  actions?: ReactNode
  className?: string
  showHeader?: boolean
  showSources?: boolean
  chartHeightClass?: string
}) {
  const rows = toRechartsRows(chart)

  return (
    <div className={cn('mt-3 rounded-lg border border-border/60 bg-muted/10 p-3', className)}>
      {showHeader ? (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white">{chart.title}</p>
            {chart.subtitle ? <p className="text-[11px] text-zinc-400">{chart.subtitle}</p> : null}
            {chart.summary ? <p className="mt-1 text-[11px] leading-relaxed text-zinc-300">{chart.summary}</p> : null}
          </div>
          <div className="flex flex-col items-end gap-2 text-[10px]">
            <div className="flex flex-col items-end gap-1">
              {chart.placeholder ? (
                <span className="rounded-full border border-amber-700/40 bg-amber-950/30 px-2 py-0.5 text-amber-200">
                  Placeholder
                </span>
              ) : null}
              {chart.confidenceLabel ? <span className="text-zinc-500">{chart.confidenceLabel}</span> : null}
            </div>
            {actions ? <div className="flex items-center justify-end gap-2">{actions}</div> : null}
          </div>
        </div>
      ) : null}

      <div className={cn('w-full', chartHeightClass)}>
        <ResponsiveContainer width="100%" height="100%">
          {chart.kind === 'line' ? (
            <LineChart data={rows}>
              <CartesianGrid stroke="#2d3342" strokeDasharray="3 3" />
              <XAxis dataKey={chart.xAxis.key} tick={{ fill: '#9ca3af', fontSize: 10 }} axisLine={{ stroke: '#374151' }} tickLine={{ stroke: '#374151' }} />
              <YAxis
                tick={{ fill: '#9ca3af', fontSize: 10 }}
                axisLine={{ stroke: '#374151' }}
                tickLine={{ stroke: '#374151' }}
                tickFormatter={(value) => formatChartValue(value, chart.yAxis.valueFormat)}
              />
              <Tooltip
                formatter={(value) => formatChartValue(value, chart.yAxis.valueFormat)}
                contentStyle={{ backgroundColor: '#09090b', border: '1px solid #27272a', color: '#fff' }}
              />
              <Legend wrapperStyle={{ fontSize: '11px' }} />
              {chart.series.map((series) => (
                <Line
                  key={series.key}
                  type="monotone"
                  dataKey={series.key}
                  name={series.label}
                  stroke={series.color ?? '#D76B3D'}
                  strokeWidth={2.5}
                  dot={{ r: 3 }}
                />
              ))}
            </LineChart>
          ) : (
            <BarChart data={rows}>
              <CartesianGrid stroke="#2d3342" strokeDasharray="3 3" />
              <XAxis dataKey={chart.xAxis.key} tick={{ fill: '#9ca3af', fontSize: 10 }} axisLine={{ stroke: '#374151' }} tickLine={{ stroke: '#374151' }} />
              <YAxis
                tick={{ fill: '#9ca3af', fontSize: 10 }}
                axisLine={{ stroke: '#374151' }}
                tickLine={{ stroke: '#374151' }}
                tickFormatter={(value) => formatChartValue(value, chart.yAxis.valueFormat)}
              />
              <Tooltip
                formatter={(value) => formatChartValue(value, chart.yAxis.valueFormat)}
                contentStyle={{ backgroundColor: '#09090b', border: '1px solid #27272a', color: '#fff' }}
              />
              <Legend wrapperStyle={{ fontSize: '11px' }} />
              {chart.series.map((series) => (
                <Bar key={series.key} dataKey={series.key} name={series.label} fill={series.color ?? '#60a5fa'} radius={[4, 4, 0, 0]} />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>

      {showSources ? (
        <div className="mt-3 border-t border-border/60 pt-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Sources</p>
          <div className="mt-1 space-y-1">
            {chart.citations.map((citation) => (
              <p key={citation.id} className="text-[10px] leading-relaxed text-zinc-400">
                <span className="font-medium text-zinc-200">{citation.label}</span>
                {citation.periodLabel ? ` · ${citation.periodLabel}` : ''}
                {citation.note ? <> · <LinkifiedText text={citation.note} /></> : null}
                {citation.placeholder ? ' · placeholder' : ''}
              </p>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
