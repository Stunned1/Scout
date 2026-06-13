import React from 'react'
import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer'

import { GroupedBarChartPdf, MultiLineChartPdf } from '@/lib/report/pdf-charts'
import { buildPdfChartSeries } from '@/lib/report/scout-chart-pdf-adapter'
import { COVER_NOTES_PLACEHOLDER, type SavedChartsPdfPayload, type SavedOutputPdfRecord } from '@/lib/report/saved-charts-export'

const accent = '#D76B3D'
const ink = '#18181B'
const muted = '#52525B'
const soft = '#F4F4F5'
const border = '#E4E4E7'

const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingHorizontal: 40,
    paddingBottom: 40,
    fontFamily: 'Helvetica',
    fontSize: 10,
    color: ink,
    backgroundColor: '#FFFFFF',
  },
  headerBand: {
    backgroundColor: '#0A0A0A',
    paddingVertical: 14,
    paddingHorizontal: 40,
    marginHorizontal: -40,
    marginTop: -36,
    marginBottom: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brandWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  logo: {
    width: 18,
    height: 18,
  },
  brand: {
    color: '#FFFFFF',
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: 'bold',
  },
  meta: {
    color: '#A1A1AA',
    fontSize: 8,
    textAlign: 'right',
  },
  kicker: {
    color: accent,
    fontSize: 8,
    fontWeight: 'bold',
    letterSpacing: 1.1,
    marginBottom: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 10,
    lineHeight: 1.2,
  },
  intro: {
    fontSize: 10,
    lineHeight: 1.45,
    color: '#27272A',
    marginBottom: 14,
  },
  noteBox: {
    borderWidth: 1,
    borderColor: '#F3D0BF',
    backgroundColor: '#FFFAF7',
    borderRadius: 6,
    padding: 12,
    marginBottom: 14,
  },
  noteTitle: {
    fontSize: 9,
    fontWeight: 'bold',
    color: accent,
    marginBottom: 6,
  },
  noteText: {
    fontSize: 9,
    lineHeight: 1.5,
    color: '#3F3F46',
  },
  listItem: {
    borderWidth: 1,
    borderColor: border,
    borderRadius: 6,
    padding: 10,
    marginBottom: 8,
    backgroundColor: soft,
  },
  listTitle: {
    fontSize: 10,
    fontWeight: 'bold',
    color: ink,
    marginBottom: 3,
  },
  listMeta: {
    fontSize: 8,
    color: muted,
    lineHeight: 1.4,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 6,
    lineHeight: 1.2,
  },
  subhead: {
    fontSize: 9,
    color: muted,
    marginBottom: 8,
  },
  body: {
    fontSize: 9,
    lineHeight: 1.5,
    color: '#27272A',
    marginBottom: 12,
  },
  card: {
    borderWidth: 1,
    borderColor: border,
    borderRadius: 6,
    padding: 12,
    marginBottom: 12,
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 6,
  },
  statLabel: {
    fontSize: 8,
    color: muted,
  },
  statValue: {
    fontSize: 9,
    color: ink,
    fontWeight: 'bold',
  },
  footer: {
    marginTop: 14,
    fontSize: 7,
    color: muted,
    lineHeight: 1.4,
  },
})

function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function renderChart(record: Extract<SavedOutputPdfRecord, { kind: 'chart' }>) {
  const series = buildPdfChartSeries(record.payload)
  if (record.payload.kind === 'line') {
    return <MultiLineChartPdf series={series} width={470} height={180} />
  }

  return <GroupedBarChartPdf series={series} width={470} height={200} caption={record.payload.yAxis.label} />
}

function outputTitle(record: SavedOutputPdfRecord): string {
  const override = record.displayTitle?.trim()
  if (override) return override
  if (record.kind === 'chart') return record.payload.title
  if (record.kind === 'stat_card') return record.payload.title
  if (record.kind === 'permit_detail') return record.payload.title
  return record.payload.siteLabel
}

function outputKindLabel(record: SavedOutputPdfRecord): string {
  if (record.kind === 'chart') return 'Chart'
  if (record.kind === 'stat_card') return 'Stat card'
  if (record.kind === 'places_context') return 'Nearby context'
  if (record.kind === 'permit_detail') return 'Permit detail'
  return 'Site snapshot'
}

type SavedOutputRenderGroup =
  | { kind: 'single'; record: SavedOutputPdfRecord }
  | {
      kind: 'site'
      siteLabel: string
      marketLabel?: string | null
      uploadedPin: Extract<SavedOutputPdfRecord, { kind: 'uploaded_pin' }>
      placesContext?: Extract<SavedOutputPdfRecord, { kind: 'places_context' }> | null
    }

function buildSiteGroupKey(record: Extract<SavedOutputPdfRecord, { kind: 'uploaded_pin' | 'places_context' }>): string {
  return [
    record.payload.siteLabel.trim().toLowerCase(),
    record.payload.lat.toFixed(5),
    record.payload.lng.toFixed(5),
  ].join(':')
}

export function buildSavedOutputRenderGroups(records: SavedOutputPdfRecord[]): SavedOutputRenderGroup[] {
  const groups: SavedOutputRenderGroup[] = []
  const siteGroupIndexes = new Map<string, number>()

  for (const record of records) {
    if (record.kind !== 'uploaded_pin' && record.kind !== 'places_context') {
      groups.push({ kind: 'single', record })
      continue
    }

    const siteKey = buildSiteGroupKey(record)
    const existingIndex = siteGroupIndexes.get(siteKey)
    if (existingIndex == null) {
      if (record.kind === 'uploaded_pin') {
        groups.push({
          kind: 'site',
          siteLabel: record.payload.siteLabel,
          marketLabel: record.marketLabel ?? null,
          uploadedPin: record,
          placesContext: null,
        })
        siteGroupIndexes.set(siteKey, groups.length - 1)
        continue
      }

      groups.push({ kind: 'single', record })
      continue
    }

    const existingGroup = groups[existingIndex]
    if (!existingGroup || existingGroup.kind !== 'site') {
      groups.push({ kind: 'single', record })
      continue
    }

    if (record.kind === 'places_context' && !existingGroup.placesContext) {
      existingGroup.placesContext = record
      continue
    }

    groups.push({ kind: 'single', record })
  }

  return groups
}

export function SavedChartsPdfDocument({
  payload,
  logoDataUri,
}: {
  payload: SavedChartsPdfPayload
  logoDataUri: string | null
}) {
  const generatedAt = formatTimestamp(payload.generatedAt)
  const notes = payload.notes.trim()
  const renderGroups = buildSavedOutputRenderGroups(payload.outputs)

  return (
    <Document title={payload.title}>
      <Page size="A4" style={styles.page}>
        <View style={styles.headerBand}>
          <View style={styles.brandWrap}>
            {logoDataUri ? <Image src={logoDataUri} style={styles.logo} /> : null}
            <Text style={styles.brand}>SCOUT</Text>
          </View>
          <Text style={styles.meta}>{generatedAt}</Text>
        </View>

        <Text style={styles.kicker}>Saved Output Export</Text>
        <Text style={styles.title}>{payload.title}</Text>
        <Text style={styles.intro}>
          This PDF groups the saved outputs you selected in Scout into a plain-language export that is easier to scan, share,
          and review outside the product.
        </Text>

        <View style={styles.noteBox}>
          <Text style={styles.noteTitle}>Notes for readers</Text>
          <Text style={styles.noteText}>{notes || COVER_NOTES_PLACEHOLDER}</Text>
        </View>

        {payload.outputs.map((record, index) => (
          <View key={record.id} style={styles.listItem}>
            <Text style={styles.listTitle}>
              {index + 1}. {outputTitle(record)}
            </Text>
            <Text style={styles.listMeta}>Type: {outputKindLabel(record)}</Text>
            {'prompt' in record && record.prompt ? <Text style={styles.listMeta}>Prompt: {record.prompt}</Text> : null}
            {record.marketLabel ? <Text style={styles.listMeta}>Market: {record.marketLabel}</Text> : null}
            <Text style={styles.listMeta}>Saved: {formatTimestamp(record.savedAt)}</Text>
          </View>
        ))}

        <Text style={styles.footer}>
          Saved outputs are exported from the current browser session. Charts keep their chart contract, while saved context cards
          and site snapshots render as structured report sections.
        </Text>
      </Page>

      {renderGroups.map((group, index) => (
        <Page
          key={group.kind === 'single' ? group.record.id : group.uploadedPin.id}
          size="A4"
          style={styles.page}
        >
          <View style={styles.headerBand}>
            <View style={styles.brandWrap}>
              {logoDataUri ? <Image src={logoDataUri} style={styles.logo} /> : null}
              <Text style={styles.brand}>SCOUT</Text>
            </View>
            <Text style={styles.meta}>
              Output {index + 1} of {renderGroups.length}
            </Text>
          </View>

          {group.kind === 'single' ? (
            <>
              <Text style={styles.kicker}>{outputKindLabel(group.record)}</Text>
              <Text style={styles.sectionTitle}>{outputTitle(group.record)}</Text>
              <Text style={styles.subhead}>
                {'prompt' in group.record && group.record.prompt ? `Prompt: ${group.record.prompt}` : 'Saved sidebar artifact'}
                {group.record.marketLabel ? `  |  Market: ${group.record.marketLabel}` : ''}
              </Text>

              {group.record.note?.trim() ? (
                <View style={styles.noteBox}>
                  <Text style={styles.noteTitle}>Analyst note</Text>
                  <Text style={styles.noteText}>{group.record.note.trim()}</Text>
                </View>
              ) : null}

              {group.record.kind === 'chart' ? (
                <View style={styles.card}>{renderChart(group.record)}</View>
              ) : null}

              {group.record.kind === 'stat_card' ? (
                <View style={styles.card}>
                  {group.record.payload.summary ? <Text style={styles.body}>{group.record.payload.summary}</Text> : null}
                  {group.record.payload.stats.map((stat) => (
                    <View key={stat.label} style={styles.statRow}>
                      <Text style={styles.statLabel}>{stat.label}</Text>
                      <Text style={styles.statValue}>{stat.value}</Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {group.record.kind === 'places_context' ? (
                <View style={styles.card}>
                  <Text style={styles.body}>{group.record.payload.summary}</Text>
                  {group.record.payload.countsByCategory.map((entry) => (
                    <View key={entry.category} style={styles.statRow}>
                      <Text style={styles.statLabel}>{entry.label}</Text>
                      <Text style={styles.statValue}>{String(entry.count)}</Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {group.record.kind === 'uploaded_pin' ? (
                <View style={styles.card}>
                  <Text style={styles.body}>
                    {group.record.payload.lat.toFixed(5)}, {group.record.payload.lng.toFixed(5)}
                  </Text>
                  {Object.entries(group.record.payload.rowPreview).slice(0, 8).map(([label, value]) => (
                    <View key={label} style={styles.statRow}>
                      <Text style={styles.statLabel}>{label}</Text>
                      <Text style={styles.statValue}>{String(value)}</Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {group.record.kind === 'permit_detail' ? (
                <View style={styles.card}>
                  <Text style={styles.body}>{group.record.payload.addressOrPlace}</Text>
                  <Text style={styles.subhead}>
                    {group.record.payload.categoryLabel} | {group.record.payload.sourceName}
                    {group.record.payload.dateLabel ? ` | ${group.record.payload.dateLabel}` : ''}
                  </Text>
                  {group.record.payload.stats.map((stat) => (
                    <View key={`${stat.label}:${stat.value}`} style={styles.statRow}>
                      <Text style={styles.statLabel}>{stat.label}</Text>
                      <Text style={styles.statValue}>{stat.value}</Text>
                    </View>
                  ))}
                  {group.record.payload.sourceUrl ? (
                    <Text style={styles.footer}>Source: {group.record.payload.sourceUrl}</Text>
                  ) : null}
                </View>
              ) : null}

              <Text style={styles.footer}>Saved in Scout on {formatTimestamp(group.record.savedAt)}.</Text>
            </>
          ) : (
            <>
              <Text style={styles.kicker}>Site bundle</Text>
              <Text style={styles.sectionTitle}>{group.uploadedPin.displayTitle?.trim() || group.siteLabel}</Text>
              <Text style={styles.subhead}>
                Saved uploaded-site bundle
                {group.marketLabel ? `  |  Market: ${group.marketLabel}` : ''}
              </Text>

              {group.uploadedPin.note?.trim() || group.placesContext?.note?.trim() ? (
                <View style={styles.noteBox}>
                  <Text style={styles.noteTitle}>Analyst note</Text>
                  <Text style={styles.noteText}>
                    {[group.uploadedPin.note?.trim(), group.placesContext?.note?.trim()].filter(Boolean).join('\n')}
                  </Text>
                </View>
              ) : null}

              <View style={styles.card}>
                <Text style={styles.noteTitle}>Site snapshot</Text>
                <Text style={styles.body}>
                  {group.uploadedPin.payload.lat.toFixed(5)}, {group.uploadedPin.payload.lng.toFixed(5)}
                </Text>
                {Object.entries(group.uploadedPin.payload.rowPreview).slice(0, 8).map(([label, value]) => (
                  <View key={label} style={styles.statRow}>
                    <Text style={styles.statLabel}>{label}</Text>
                    <Text style={styles.statValue}>{String(value)}</Text>
                  </View>
                ))}
              </View>

              {group.placesContext ? (
                <View style={styles.card}>
                  <Text style={styles.noteTitle}>Nearby context</Text>
                  <Text style={styles.body}>{group.placesContext.payload.summary}</Text>
                  {group.placesContext.payload.countsByCategory.map((entry) => (
                    <View key={entry.category} style={styles.statRow}>
                      <Text style={styles.statLabel}>{entry.label}</Text>
                      <Text style={styles.statValue}>{String(entry.count)}</Text>
                    </View>
                  ))}
                </View>
              ) : null}

              <Text style={styles.footer}>
                Saved in Scout on {formatTimestamp(group.uploadedPin.savedAt)}
                {group.placesContext ? `; nearby context saved on ${formatTimestamp(group.placesContext.savedAt)}.` : '.'}
              </Text>
            </>
          )}
        </Page>
      ))}
    </Document>
  )
}
