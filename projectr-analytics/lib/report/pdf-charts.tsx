import React, { Fragment } from 'react'
import { Svg, Line, Polyline, Rect, Text as SvgText } from '@react-pdf/renderer'

function normY(v: number, min: number, max: number, height: number): number {
  if (max === min) return height / 2
  const t = (v - min) / (max - min)
  return height - t * height
}

export function SparklinePdf({
  data,
  width,
  height,
  color = '#D76B3D',
}: {
  data: { date: string; value: number }[]
  width: number
  height: number
  color?: string
}) {
  if (data.length < 2) {
    return (
      <Svg width={width} height={height}>
        <SvgText x={30} y={height / 2} style={{ fontSize: 7, fill: '#888' }}>
          Insufficient series
        </SvgText>
      </Svg>
    )
  }
  const vals = data.map((d) => d.value)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const padL = 30
  const padR = 6
  const padY = 6
  const padB = 14
  const w = width - padL - padR
  const h = height - padY - padB
  const step = w / (data.length - 1)
  const points = data
    .map((d, i) => {
      const x = padL + i * step
      const y = padY + normY(d.value, min, max, h)
      return `${x},${y}`
    })
    .join(' ')

  const fmt = (v: number) =>
    Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1)

  return (
    <Svg width={width} height={height}>
      <Line x1={padL} y1={padY + h} x2={padL + w} y2={padY + h} stroke="#333" strokeWidth={0.5} />
      <SvgText x={2} y={padY + 7} style={{ fontSize: 6, fill: '#555' }}>
        {fmt(max)}
      </SvgText>
      <SvgText x={2} y={padY + h - 1} style={{ fontSize: 6, fill: '#555' }}>
        {fmt(min)}
      </SvgText>
      <Polyline points={points} fill="none" stroke={color} strokeWidth={1.2} />
    </Svg>
  )
}

export function BarChartPdf({
  bars,
  width,
  height,
  color = '#D76B3D',
  caption,
}: {
  bars: { label: string; value: number }[]
  width: number
  height: number
  color?: string
  /** Overrides default “Units (max …)” label above the chart. */
  caption?: string
}) {
  if (!bars.length) {
    return (
      <Svg width={width} height={height}>
        <SvgText x={4} y={height / 2} style={{ fontSize: 7, fill: '#888' }}>
          No permit series
        </SvgText>
      </Svg>
    )
  }
  const max = Math.max(...bars.map((b) => b.value), 1)
  const padTop = 30
  const padBottom = 20
  const padL = 34
  const chartH = height - padTop - padBottom
  const gap = 6
  const bw = Math.max(8, (width - padL - 6 - gap * (bars.length - 1)) / bars.length)
  const cap =
    caption ?? `Units (max ${Math.round(max).toLocaleString('en-US')})`
  return (
    <Svg width={width} height={height}>
      <SvgText x={4} y={padTop - 8} style={{ fontSize: 6, fill: '#555' }}>
        {cap}
      </SvgText>
      {bars.map((b, i) => {
        const bh = (b.value / max) * chartH
        const barX = padL + i * (bw + gap)
        const barY = padTop + chartH - bh
        return (
          <Fragment key={b.label}>
            <Rect x={barX} y={barY} width={bw} height={Math.max(bh, 1)} fill={color} />
            <SvgText
              x={barX + bw / 2}
              y={Math.max(barY - 3, padTop + 6)}
              style={{ fontSize: 6, fill: '#444', textAnchor: 'middle' }}
            >
              {b.value.toLocaleString('en-US')}
            </SvgText>
            <SvgText x={barX + bw / 2} y={height - 4} style={{ fontSize: 6, fill: '#888', textAnchor: 'middle' }}>
              {b.label}
            </SvgText>
          </Fragment>
        )
      })}
    </Svg>
  )
}

export interface PdfChartSeries {
  label: string
  color?: string | null
  points: { x: string; y: number }[]
}

const SERIES_PALETTE = ['#D76B3D', '#64748B', '#0F766E', '#7C3AED', '#B45309']

function seriesColor(series: PdfChartSeries, index: number): string {
  return series.color ?? SERIES_PALETTE[index % SERIES_PALETTE.length]
}

/** Category labels in first-appearance order across every series. */
function unionCategories(series: PdfChartSeries[]): string[] {
  const categories: string[] = []
  const seen = new Set<string>()
  for (const entry of series) {
    for (const point of entry.points) {
      if (seen.has(point.x)) continue
      seen.add(point.x)
      categories.push(point.x)
    }
  }
  return categories
}

function LegendPdf({ series, x, y }: { series: PdfChartSeries[]; x: number; y: number }) {
  // ~3.2pt per character at 6pt Helvetica; close enough for legend spacing.
  const offsets = series.reduce<number[]>((acc, entry, index) => {
    acc.push(index === 0 ? x : acc[index - 1] + series[index - 1].label.length * 3.2 + 22)
    return acc
  }, [])
  return (
    <>
      {series.map((entry, index) => {
        const swatchX = offsets[index]
        return (
          <Fragment key={`${entry.label}-${index}`}>
            <Rect x={swatchX} y={y - 5} width={6} height={6} fill={seriesColor(entry, index)} />
            <SvgText x={swatchX + 9} y={y} style={{ fontSize: 6, fill: '#444' }}>
              {entry.label}
            </SvgText>
          </Fragment>
        )
      })}
    </>
  )
}

/** Vertical bars grouped per category; one bar per series, with a legend when there are 2+. */
export function GroupedBarChartPdf({
  series,
  width,
  height,
  caption,
}: {
  series: PdfChartSeries[]
  width: number
  height: number
  caption?: string
}) {
  const categories = unionCategories(series)
  if (series.length === 0 || categories.length === 0) {
    return (
      <Svg width={width} height={height}>
        <SvgText x={4} y={height / 2} style={{ fontSize: 7, fill: '#888' }}>
          No chart series
        </SvgText>
      </Svg>
    )
  }

  const valuesBySeries = series.map((entry) => {
    const byCategory = new Map(entry.points.map((point) => [point.x, point.y]))
    return categories.map((category) => byCategory.get(category) ?? 0)
  })
  const max = Math.max(...valuesBySeries.flat(), 1)

  const showLegend = series.length > 1
  const padTop = showLegend ? 38 : 30
  const padBottom = 20
  const padL = 34
  const chartH = height - padTop - padBottom
  const groupGap = 10
  const barGap = 2
  const groupW = Math.max(10, (width - padL - 6 - groupGap * (categories.length - 1)) / categories.length)
  const barW = Math.max(4, (groupW - barGap * (series.length - 1)) / series.length)
  const showValues = categories.length * series.length <= 14

  return (
    <Svg width={width} height={height}>
      <SvgText x={4} y={12} style={{ fontSize: 6, fill: '#555' }}>
        {caption ?? `Values (max ${Math.round(max).toLocaleString('en-US')})`}
      </SvgText>
      {showLegend ? <LegendPdf series={series} x={padL} y={padTop - 10} /> : null}
      <Line x1={padL} y1={padTop + chartH} x2={width - 6} y2={padTop + chartH} stroke="#333" strokeWidth={0.5} />
      {categories.map((category, categoryIndex) => {
        const groupX = padL + categoryIndex * (groupW + groupGap)
        return (
          <Fragment key={category}>
            {series.map((entry, seriesIndex) => {
              const value = valuesBySeries[seriesIndex][categoryIndex]
              const barH = (value / max) * chartH
              const barX = groupX + seriesIndex * (barW + barGap)
              const barY = padTop + chartH - barH
              return (
                <Fragment key={`${entry.label}-${seriesIndex}`}>
                  <Rect x={barX} y={barY} width={barW} height={Math.max(barH, value > 0 ? 1 : 0)} fill={seriesColor(entry, seriesIndex)} />
                  {showValues ? (
                    <SvgText
                      x={barX + barW / 2}
                      y={Math.max(barY - 3, padTop + 6)}
                      style={{ fontSize: 5.5, fill: '#444', textAnchor: 'middle' }}
                    >
                      {value.toLocaleString('en-US')}
                    </SvgText>
                  ) : null}
                </Fragment>
              )
            })}
            <SvgText x={groupX + groupW / 2} y={height - 4} style={{ fontSize: 6, fill: '#888', textAnchor: 'middle' }}>
              {category.length > 18 ? `${category.slice(0, 16)}…` : category}
            </SvgText>
          </Fragment>
        )
      })}
    </Svg>
  )
}

/** One polyline per series on a shared scale, with a legend when there are 2+. */
export function MultiLineChartPdf({
  series,
  width,
  height,
}: {
  series: PdfChartSeries[]
  width: number
  height: number
}) {
  const categories = unionCategories(series)
  const allValues = series.flatMap((entry) => entry.points.map((point) => point.y))
  if (categories.length < 2 || allValues.length < 2) {
    return (
      <Svg width={width} height={height}>
        <SvgText x={30} y={height / 2} style={{ fontSize: 7, fill: '#888' }}>
          Insufficient series
        </SvgText>
      </Svg>
    )
  }

  const min = Math.min(...allValues)
  const max = Math.max(...allValues)
  const categoryIndex = new Map(categories.map((category, index) => [category, index]))
  const showLegend = series.length > 1
  const padL = 30
  const padR = 6
  const padY = showLegend ? 18 : 6
  const padB = 14
  const w = width - padL - padR
  const h = height - padY - padB
  const step = w / (categories.length - 1)

  const fmt = (v: number) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1))

  return (
    <Svg width={width} height={height}>
      {showLegend ? <LegendPdf series={series} x={padL} y={10} /> : null}
      <Line x1={padL} y1={padY + h} x2={padL + w} y2={padY + h} stroke="#333" strokeWidth={0.5} />
      <SvgText x={2} y={padY + 7} style={{ fontSize: 6, fill: '#555' }}>
        {fmt(max)}
      </SvgText>
      <SvgText x={2} y={padY + h - 1} style={{ fontSize: 6, fill: '#555' }}>
        {fmt(min)}
      </SvgText>
      {series.map((entry, index) => {
        const points = entry.points
          .filter((point) => categoryIndex.has(point.x))
          .map((point) => {
            const x = padL + (categoryIndex.get(point.x) ?? 0) * step
            const y = padY + normY(point.y, min, max, h)
            return `${x},${y}`
          })
          .join(' ')
        if (!points) return null
        return <Polyline key={`${entry.label}-${index}`} points={points} fill="none" stroke={seriesColor(entry, index)} strokeWidth={1.2} />
      })}
    </Svg>
  )
}

/** Left-aligned labels; horizontal bars - good for comparing sites on one metric. */
export function HorizontalBarChartPdf({
  rows,
  width,
  height,
  color = '#D76B3D',
  caption,
  formatValue,
}: {
  rows: { label: string; value: number }[]
  width: number
  height: number
  color?: string
  caption?: string
  /** Override bar-end labels (e.g. values already in millions). */
  formatValue?: (v: number) => string
}) {
  if (!rows.length) {
    return (
      <Svg width={width} height={height}>
        <SvgText x={4} y={height / 2} style={{ fontSize: 7, fill: '#888' }}>
          No rows
        </SvgText>
      </Svg>
    )
  }
  const max = Math.max(...rows.map((r) => r.value), 1)
  const padT = caption ? 22 : 10
  const padB = 8
  const labelW = Math.min(86, width * 0.26)
  const barX0 = labelW + 6
  const barW = width - barX0 - 6
  const innerH = height - padT - padB
  const rowH = innerH / rows.length
  const barH = Math.max(5, rowH - 5)

  const fmt =
    formatValue ??
    ((v: number) =>
      v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(v >= 10 ? 0 : 1))

  return (
    <Svg width={width} height={height}>
      {caption ? (
        <SvgText x={4} y={12} style={{ fontSize: 6, fill: '#555' }}>
          {caption}
        </SvgText>
      ) : null}
      {rows.map((r, i) => {
        const y = padT + i * rowH + (rowH - barH) / 2
        const fillW = (r.value / max) * barW
        return (
          <Fragment key={`${r.label}-${i}`}>
            <SvgText x={2} y={y + barH - 1} style={{ fontSize: 6, fill: '#333' }}>
              {r.label.length > 22 ? `${r.label.slice(0, 20)}…` : r.label}
            </SvgText>
            <Rect x={barX0} y={y} width={barW} height={barH} fill="#ececec" />
            <Rect x={barX0} y={y} width={Math.max(fillW, r.value > 0 ? 1 : 0)} height={barH} fill={color} />
            <SvgText x={barX0 + fillW + 3} y={y + barH - 1} style={{ fontSize: 6, fill: '#444' }}>
              {fmt(r.value)}
            </SvgText>
          </Fragment>
        )
      })}
    </Svg>
  )
}
