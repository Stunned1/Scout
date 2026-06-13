import { normalizeScoutChartOutput, type ScoutChartOutput } from '@/lib/scout-chart-output'
import type { ZoriSeriesSource } from './fetch-zori-series'

export function buildZoriTrendChart(
  series: { date: string; value: number }[],
  marketLabel: string,
  source: ZoriSeriesSource
): ScoutChartOutput {
  return normalizeScoutChartOutput({
    kind: 'line',
    title: `${marketLabel} rent trend`,
    subtitle: source === 'zillow_monthly' ? 'Monthly Zillow Research history' : 'Modeled rent history',
    summary:
      source === 'zillow_monthly'
        ? 'Grounded rent history from persisted Zillow monthly series.'
        : 'Modeled series derived from the latest level and YoY change.',
    placeholder: source !== 'zillow_monthly',
    confidenceLabel: source === 'zillow_monthly' ? 'zillow monthly history' : 'modeled from latest + YoY',
    xAxis: { key: 'period', label: 'Period' },
    yAxis: { label: 'ZORI', valueFormat: 'currency' },
    series: [
      {
        key: 'zori',
        label: 'ZORI',
        color: '#D76B3D',
        points: series.map((point) => ({ x: point.date, y: point.value })),
      },
    ],
    citations: [
      {
        id: `zori-${source}`,
        label: 'Zillow Research',
        sourceType: source === 'zillow_monthly' ? 'internal_dataset' : 'derived',
        note:
          source === 'zillow_monthly'
            ? 'Monthly ZORI series from zillow_zori_monthly.'
            : 'Modeled from the latest ZORI level and YoY growth when monthly history is unavailable.',
        placeholder: source !== 'zillow_monthly',
      },
    ],
  })
}

export function buildPermitUnitsChart(years: { year: string; units: number }[]): ScoutChartOutput {
  return normalizeScoutChartOutput({
    kind: 'bar',
    title: 'Permit acceleration',
    subtitle: 'Census BPS county series',
    summary: 'Permit units by year for the county-level BPS series used in the market report.',
    xAxis: { key: 'year', label: 'Year' },
    yAxis: { label: 'Permit units', valueFormat: 'number' },
    series: [
      {
        key: 'permit_units',
        label: 'Permit units',
        color: '#D76B3D',
        points: years.map((row) => ({ x: row.year, y: row.units })),
      },
    ],
    citations: [
      {
        id: 'permit-units-census-bps',
        label: 'Census BPS',
        sourceType: 'internal_dataset',
        note: 'County-level permit units used for the report chart.',
      },
    ],
  })
}

export function buildSearchTrendsChart(series: { date: string; value: number }[], keywordScope: string): ScoutChartOutput {
  return normalizeScoutChartOutput({
    kind: 'line',
    title: 'Search sentiment',
    subtitle: keywordScope,
    summary: 'Recent Google Trends series used in the market report.',
    xAxis: { key: 'period', label: 'Period' },
    yAxis: { label: 'Search interest', valueFormat: 'number' },
    series: [
      {
        key: 'search_interest',
        label: 'Search interest',
        color: '#64748b',
        points: series.map((point) => ({ x: point.date, y: point.value })),
      },
    ],
    citations: [
      {
        id: 'google-trends-series',
        label: 'Google Trends',
        sourceType: 'public_dataset',
        note: keywordScope,
      },
    ],
  })
}

/** Keeps every series (unlike the single-series helpers below) for grouped/multi-line PDF charts. */
export function buildPdfChartSeries(chart: ScoutChartOutput): { label: string; color?: string | null; points: { x: string; y: number }[] }[] {
  return chart.series.map((series) => ({
    label: series.label,
    color: series.color ?? null,
    points: series.points.map((point) => ({ x: point.x, y: point.y })),
  }))
}

export function buildPdfSeriesFromScoutChart(chart: ScoutChartOutput): { date: string; value: number }[] {
  const series = chart.series[0]
  if (!series) return []
  return series.points.map((point) => ({ date: point.x, value: point.y }))
}

export function buildPdfBarRowsFromScoutChart(chart: ScoutChartOutput): { label: string; value: number }[] {
  const series = chart.series[0]
  if (!series) return []
  return series.points.map((point) => ({ label: point.x, value: point.y }))
}
