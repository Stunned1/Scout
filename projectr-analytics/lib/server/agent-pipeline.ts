/**
 * Scout EDA Assistant API
 * Returns a concise analyst-facing response grounded in the current market or imported dataset context.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { normalizeAgentTrace } from '@/lib/agent-trace'
import {
  validateAgentGroundingPayloadWithService,
  type AgentGroundingValidation,
} from '@/lib/agent-grounding-validator'
import type {
  AgentAction,
  AgentCompanionOutput,
  AgentDriveTimeEvidenceResult,
  AgentDriveTimeQuery,
  AgentHistoryMetric,
  AgentHistorySubject,
  AgentHistoryTimeWindow,
  AgentStep,
  AgentTrace,
  MapContext,
} from '@/lib/agent-types'
import { classifyAgentRequestIntent, looksAnalyticalPrompt } from '@/lib/agent-intent'
import {
  humanizeLayerKey,
  inferDirectMapControl,
  MAP_CONTROL_LAYER_KEYS,
  normalizeMapSearchQuery,
} from '@/lib/agent-map-control'
import { buildEdaContextString, buildFallbackEdaResponse, inferEdaTaskType } from '@/lib/eda-assistant'
import { evaluateAgentRequestPolicy } from '@/lib/agent-request-policy'
import { GEMINI_NO_EM_DASH_RULE } from '@/lib/gemini-text-rules'
import { retrievePublicMacroEvidence } from '@/lib/agent-public-grounding'
import { retrieveInternalEvidence, type AgentInternalEvidenceResult } from '@/lib/agent-internal-grounding'
import { buildCountyAreaKey, buildMetroAreaKey, normalizeCountyDisplayName, normalizeMetroDisplayName } from '@/lib/area-keys'
import { normalizeScoutChartOutput, type ScoutChartCitation, type ScoutChartOutput } from '@/lib/scout-chart-output'
import type { AnalyticalComparisonRequest, AnalyticalComparisonResult } from '@/lib/data/market-data-router'
import type { MasterDataRow } from '@/lib/data/types'
import { normalizeUsStateToAbbr, splitTrailingUsState } from '@/lib/us-state-abbr'
import { buildCoreRetailComparison, type CoreRetailComparisonResult } from '@/lib/overture-core-retail-comparison'
import {
  buildConsumerMarketComparison,
  hasConsumerMarketComparisonIntent,
  type ConsumerMarketDependencies,
} from '@/lib/server/consumer-market-comparison'
import type {
  AgentInternalProvenanceQuery,
  AgentPublicMacroEvidenceResult,
  AgentPlaceGroundingQuery,
  AgentPublicMacroMetric,
  AgentPublicMacroQuery,
} from '@/lib/agent-types'
import type { AgentPlaceGroundingEvidenceResult } from '@/lib/agent-types'
import { retrieveDriveTimeGrounding } from '@/lib/agent-drive-time-grounding'
import type { TexasRawPermitResult } from '@/lib/texas-raw-permits'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SYSTEM_PROMPT = `You are Scout's EDA Assistant.

PRODUCT BOUNDARY:
- Your job is exploratory data analysis for the currently loaded market context and imported datasets.
- You may summarize datasets, describe distributions, detect outliers, compare visible segments, compare loaded geographies when context supports it, explain trend changes, explain metrics, and flag data-quality issues.
- Every claim must be grounded in the provided workspace evidence.
- Keep responses short, high-signal, and analyst-friendly.

STRICT NON-GOALS:
- No investment advice, development strategy, site recommendations, or open-ended market theses.
- No autonomous workflow planning.
- No map control instructions, layer orchestration, parcel screening, or run_analysis behavior.
- If evidence is weak or context is missing, say so plainly.

OUTPUT CONTRACT:
Return valid JSON only:
{
  "message": "2-4 sentences, concise and evidence-backed",
  "trace": {
    "summary": "one-line description of the EDA task",
    "taskType": "summarize_dataset|describe_distribution|detect_outliers|compare_segments|compare_geographies|compare_periods|spot_trends|check_data_quality|explain_metric",
    "methodology": "plain-language explanation of what evidence was used",
    "keyFindings": ["finding 1", "finding 2"],
    "evidence": ["metric or row evidence", "metric or row evidence"],
    "caveats": ["constraint or weak-evidence note"],
    "nextQuestions": ["good next EDA question"]
  }
}

STYLE RULES:
- Plain language only.
- No markdown.
- No prose outside JSON.
- Do not invent rows, metrics, benchmarks, or causal claims.
- When a quantitative claim is grounded, tag the claim with a source label in the message text using the format [source: Source Label].
- Also mention the source label in the trace evidence or methodology when it is available.
- Do not present uncited quantitative claims as grounded facts.

${GEMINI_NO_EM_DASH_RULE}`

const MAP_CONTROL_SYSTEM_PROMPT = `You are Scout's direct map-control interpreter for natural-language Scout terminal prompts.

Your job is to extract the intended UI control plan from a prompt that Scout already classified as direct map control.

SUPPORTED ACTIONS:
- search
- toggle_layers
- set_tilt
- focus_data_panel
- generate_memo
- none

SUPPORTED LAYER KEYS:
- ${MAP_CONTROL_LAYER_KEYS.join('\n- ')}

RULES:
- Interpret natural-language phrasing semantically. Ignore filler such as "please", "can you", or "let's".
- You may return either one direct action or an ordered "steps" array with up to 3 actions.
- Prefer "search" when the user is clearly asking to navigate to a geography or market.
- If the prompt combines navigation with another direct map action, return both steps in order. Search should come first.
- If the prompt combines map control and analysis, extract only the direct map-control action(s) and ignore the analysis clause.
- Do not invent geography names, layers, or parameters.
- Use "none" if confidence is below 0.6 or the prompt is too ambiguous.
- For toggle_layers, return a JSON object whose keys are layer keys and whose values are booleans.
- For set_tilt, return a tilt from 0 to 60.
- Keep step messages short and user-facing.

OUTPUT CONTRACT:
Return valid JSON only:
{
  "message": "short user-facing summary",
  "actionType": "search|toggle_layers|set_tilt|focus_data_panel|generate_memo|none",
  "searchQuery": "string or null",
  "layers": { "transitStops": true },
  "tilt": 45,
  "steps": [
    {
      "message": "Navigating to Dallas, TX.",
      "actionType": "search",
      "searchQuery": "Dallas, TX"
    },
    {
      "message": "Turning on permits.",
      "actionType": "toggle_layers",
      "layers": { "permits": true }
    }
  ],
  "confidence": 0.0,
  "reason": "short explanation"
}

${GEMINI_NO_EM_DASH_RULE}`

type AgentJsonResponse = {
  message: string
  trace?: unknown
  chart?: unknown
}

type MapControlActionJson = {
  actionType?: unknown
  searchQuery?: unknown
  layers?: unknown
  tilt?: unknown
  message?: unknown
}

type MapControlPlanJson = MapControlActionJson & {
  steps?: unknown
  confidence?: unknown
  reason?: unknown
}

function parseGeminiAgentJson(raw: string): AgentJsonResponse {
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim()
    return JSON.parse(cleaned) as AgentJsonResponse
  } catch {
    try {
      const match = raw.match(/\{[\s\S]*\}/)
      if (match) return JSON.parse(match[0]) as AgentJsonResponse
    } catch {
      /* ignore */
    }
  }

  return { message: raw.trim() || 'Unable to interpret the current workspace context.' }
}

function parseMapControlPlanJson(raw: string): MapControlPlanJson {
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim()
    return JSON.parse(cleaned) as MapControlPlanJson
  } catch {
    try {
      const match = raw.match(/\{[\s\S]*\}/)
      if (match) return JSON.parse(match[0]) as MapControlPlanJson
    } catch {
      /* ignore */
    }
  }

  return {}
}

function getGeminiJsonModel(systemInstruction: string) {
  return new GoogleGenerativeAI(process.env.GEMINI_API_KEY!).getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction,
    generationConfig: { responseMimeType: 'application/json' },
  })
}

function mergeTrace(primary: AgentTrace, fallback: AgentTrace): AgentTrace {
  return {
    summary: primary.summary || fallback.summary,
    taskType: primary.taskType ?? fallback.taskType,
    methodology: primary.methodology ?? fallback.methodology,
    keyFindings: primary.keyFindings?.length ? primary.keyFindings : fallback.keyFindings,
    evidence: primary.evidence?.length ? primary.evidence : fallback.evidence,
    caveats: primary.caveats?.length ? primary.caveats : fallback.caveats,
    nextQuestions: primary.nextQuestions?.length ? primary.nextQuestions : fallback.nextQuestions,
    thinking: primary.thinking ?? fallback.thinking,
    detail: primary.detail ?? fallback.detail,
    plan: primary.plan?.length ? primary.plan : fallback.plan,
    eval: primary.eval ?? fallback.eval,
    executionSteps: primary.executionSteps?.length ? primary.executionSteps : fallback.executionSteps,
    toolCalls: primary.toolCalls?.length ? primary.toolCalls : fallback.toolCalls,
  }
}

function buildHybridMapAnalysisTrace(summary: string, findings: string[], caveats: string[], nextQuestions: string[]): AgentTrace {
  return {
    summary,
    taskType: 'summarize_dataset',
    methodology: 'Matched the prompt as a hybrid of explicit map control and workspace-grounded analysis, then sequenced the response without using open-ended planning.',
    keyFindings: findings,
    evidence: ['The prompt included an explicit navigation or map-control command plus an analytical follow-up request.'],
    caveats,
    nextQuestions,
  }
}

function normalizeLayerRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, enabled]) => MAP_CONTROL_LAYER_KEYS.includes(key) && typeof enabled === 'boolean')
  )
}

type NormalizedMapControlStep = {
  message: string
  action: AgentAction
  summary: string
}

type AgentPipelineResult = {
  message: string
  action?: AgentAction
  steps?: AgentStep[]
  trace: AgentTrace
  chart?: ScoutChartOutput | null
  companionOutputs?: AgentCompanionOutput[]
}

type GroundingValidationPayload = {
  message: string
  trace: AgentTrace
  chart?: ScoutChartOutput | null
  synthetic: boolean
}

type GroundingValidationFn = (payload: GroundingValidationPayload) => Promise<AgentGroundingValidation>

type AgentCitation = ScoutChartOutput['citations'][number]

function getCanonicalEvidenceCitations(result: AgentPipelineResult): AgentCitation[] {
  return result.chart?.citations?.length ? result.chart.citations : result.trace.citations ?? []
}

function hasSyntheticEvidenceSignal(result: AgentPipelineResult, citations: readonly AgentCitation[]): boolean {
  return (
    result.chart?.placeholder === true ||
    citations.some((citation) => citation.placeholder === true || citation.sourceType === 'placeholder')
  )
}

const SOURCE_TAGGED_SENTENCE_PATTERN = /\[source:[^\]]+\]/i
const QUANTITATIVE_SENTENCE_PATTERN =
  /\$[\d,]+|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?%|\b\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?|mi|miles?)\b|\b-?\d{1,3}\.\d{2,}\s*,\s*-?\d{1,3}\.\d{2,}\b/

function tagQuantitativeClaims(message: string, citations: readonly AgentCitation[]): string {
  const sourceLabels = Array.from(
    new Set(
      citations
        .map((citation) => citation.label.trim())
        .filter((label) => label.length > 0)
    )
  )
  if (sourceLabels.length === 0) return message

  const sourceTag = `[source: ${sourceLabels.slice(0, 2).join('; ')}]`
  return message.replace(/[^.!?]+[.!?]?/g, (sentence) => {
    if (!QUANTITATIVE_SENTENCE_PATTERN.test(sentence) || SOURCE_TAGGED_SENTENCE_PATTERN.test(sentence)) {
      return sentence
    }

    const trimmed = sentence.trimEnd()
    const punctuationMatch = trimmed.match(/[.!?]$/)
    const punctuation = punctuationMatch?.[0] ?? null
    if (!punctuation) return `${trimmed} ${sourceTag}`
    return `${trimmed.slice(0, -1)} ${sourceTag}${punctuation}`
  })
}

async function finalizeAgentPipelineResult(
  result: AgentPipelineResult,
  dependencies: {
    validateGroundingPayload?: GroundingValidationFn
  } = {}
): Promise<AgentPipelineResult> {
  const citations = getCanonicalEvidenceCitations(result)
  const taggedMessage = tagQuantitativeClaims(result.message, citations)
  const validateGroundingPayload =
    dependencies.validateGroundingPayload ?? validateAgentGroundingPayloadWithService
  const grounding = await validateGroundingPayload({
    message: taggedMessage,
    trace: result.trace,
    chart: result.chart,
    synthetic: hasSyntheticEvidenceSignal(result, citations),
  })
  const trace: AgentTrace = {
    ...result.trace,
    citations: grounding.normalizedEvidence.citations,
  }

  if (grounding.validation.status === 'synthetic' || !grounding.validation.suppressGroundedChart) {
    return {
      ...result,
      message: taggedMessage,
      trace,
    }
  }

  const evidenceMessage = grounding.validation.userMessage?.trim() ?? ''

  if (
    grounding.validation.status === 'citation_incomplete' &&
    grounding.normalizedEvidence.status === 'grounded' &&
    result.chart
  ) {
    return {
      ...result,
      message: evidenceMessage ? `${taggedMessage} ${evidenceMessage}`.trim() : taggedMessage,
      trace: {
        ...trace,
        caveats: evidenceMessage ? [...(trace.caveats ?? []), evidenceMessage] : trace.caveats,
      },
    }
  }

  return {
    ...result,
    message: evidenceMessage ? `${taggedMessage} ${evidenceMessage}`.trim() : taggedMessage,
    chart: null,
    trace: {
      ...trace,
      caveats: evidenceMessage ? [...(trace.caveats ?? []), evidenceMessage] : trace.caveats,
    },
  }
}

type MetricSeriesFetcher = (args: {
  submarketId: string
  metricName: string
  startDate: string
  dataSource?: string | readonly string[]
  limit?: number
}) => Promise<MasterDataRow[]>

type ZoriMonthlyFetcher = (zip: string, maxMonths?: number) => Promise<Array<{ date: string; value: number }>>

type RouterChartIntent = {
  metricName: string
  dataSource: string | readonly string[]
  titleMetric: string
  yAxisLabel: string
}

function inferRouterChartIntent(userMessage: string): RouterChartIntent | null {
  const prompt = userMessage.toLowerCase()
  const wantsTrend = /\b(trend|over time|history|timeline)\b/.test(prompt)
  if (!wantsTrend) return null

  if (/\bunemployment|employment|labor\b/.test(prompt)) {
    return {
      metricName: 'Unemployment_Rate',
      dataSource: 'FRED',
      titleMetric: 'unemployment',
      yAxisLabel: 'Unemployment rate',
    }
  }

  if (/\bpermit|permits|construction\b/.test(prompt)) {
    return {
      metricName: 'Permit_Units',
      dataSource: 'Census BPS',
      titleMetric: 'permits',
      yAxisLabel: 'Permit units',
    }
  }

  return null
}

function wantsRentTrend(userMessage: string): boolean {
  const prompt = userMessage.toLowerCase()
  return /\b(trend|over time|history|timeline)\b/.test(prompt) && /\b(rent|rents|zori)\b/.test(prompt)
}

async function defaultMetricSeriesFetcher(args: {
  submarketId: string
  metricName: string
  startDate: string
  dataSource?: string | readonly string[]
  limit?: number
}) {
  const { getMetricSeries } = await import('@/lib/data/market-data-router')
  return getMetricSeries(args)
}

async function defaultZoriMonthlyFetcher(zip: string, maxMonths = 24) {
  const { fetchZoriMonthlyForZip } = await import('@/lib/report/fetch-zori-series')
  return fetchZoriMonthlyForZip(zip, maxMonths)
}

async function buildRentTrendChart(
  userMessage: string,
  context: MapContext | null,
  fetchZoriMonthly: ZoriMonthlyFetcher = defaultZoriMonthlyFetcher
): Promise<ScoutChartOutput | null> {
  const zip = context?.zip?.trim()
  if (!zip || !wantsRentTrend(userMessage)) return null

  const series = await fetchZoriMonthly(zip, 24)
  if (series.length < 2) return null

  const label = context?.label ?? zip

  return normalizeScoutChartOutput({
    kind: 'line',
    title: `${label} rent trend`,
    subtitle: 'Monthly Zillow Research history',
    summary: 'Grounded rent history from the persisted Zillow monthly series.',
    placeholder: false,
    confidenceLabel: 'zillow monthly history',
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
        id: `zori-monthly-${zip}`,
        label: 'Zillow Research',
        sourceType: 'internal_dataset',
        scope: zip,
        note: 'Monthly ZORI series from zillow_zori_monthly.',
        periodLabel: `${series[0]!.date} to ${series[series.length - 1]!.date}`,
      },
    ],
  })
}

export async function buildRentTrendChartForTest(
  userMessage: string,
  context: MapContext | null,
  fetchZoriMonthly: ZoriMonthlyFetcher
) {
  return buildRentTrendChart(userMessage, context, fetchZoriMonthly)
}

async function buildRouterBackedChart(
  userMessage: string,
  context: MapContext | null,
  fetchMetricSeries: MetricSeriesFetcher = defaultMetricSeriesFetcher
): Promise<ScoutChartOutput | null> {
  const intent = inferRouterChartIntent(userMessage)
  const submarketId = context?.zip?.trim()
  if (!intent || !submarketId) return null

  const rows = await fetchMetricSeries({
    submarketId,
    metricName: intent.metricName,
    dataSource: intent.dataSource,
    startDate: '2024-01-01',
    limit: 60,
  })

  const points = rows
    .filter((row) => row.time_period && row.metric_value != null)
    .map((row) => ({
      x: row.time_period!.slice(0, 7),
      y: row.metric_value as number,
      source: row.data_source,
    }))

  if (points.length < 2) return null

  const sourceLabel = points[0]?.source ?? (Array.isArray(intent.dataSource) ? intent.dataSource[0] : intent.dataSource)
  const label = context?.label ?? submarketId

  return normalizeScoutChartOutput({
    kind: 'line',
    title: `${label} ${intent.titleMetric} trend`,
    subtitle: 'Historical series from the shared market-data router',
    summary: `Grounded ${intent.titleMetric} history for the active ZIP from the shared analytical read path.`,
    placeholder: false,
    confidenceLabel: 'router-backed series',
    xAxis: { key: 'period', label: 'Period' },
    yAxis: {
      label: intent.yAxisLabel,
      valueFormat: intent.metricName === 'Unemployment_Rate' ? 'percent' : 'number',
    },
    series: [
      {
        key: intent.metricName,
        label: intent.yAxisLabel,
        color: '#D76B3D',
        points: points.map(({ x, y }) => ({ x, y })),
      },
    ],
    citations: [
      {
        id: `${intent.metricName.toLowerCase()}-${submarketId}`,
        label: sourceLabel,
        sourceType: 'internal_dataset',
        scope: submarketId,
        note: `${intent.metricName} returned through market-data-router.`,
        periodLabel: `${points[0]!.x} to ${points[points.length - 1]!.x}`,
      },
    ],
  })
}

export async function buildRouterBackedChartForTest(
  userMessage: string,
  context: MapContext | null,
  fetchMetricSeries: MetricSeriesFetcher
) {
  return buildRouterBackedChart(userMessage, context, fetchMetricSeries)
}

type HistoryComparisonDependencies = {
  getAnalyticalComparison?: (request: AnalyticalComparisonRequest) => Promise<AnalyticalComparisonResult>
  getCoreRetailComparison?: typeof buildCoreRetailComparison
  getInternalEvidence?: (query: AgentInternalProvenanceQuery) => Promise<AgentInternalEvidenceResult>
  getPublicMacroEvidence?: (query: AgentPublicMacroQuery) => Promise<AgentPublicMacroEvidenceResult>
  getPlaceGrounding?: (query: AgentPlaceGroundingQuery) => Promise<AgentPlaceGroundingEvidenceResult>
  getDriveTimeGrounding?: (query: AgentDriveTimeQuery) => Promise<AgentDriveTimeEvidenceResult>
  getTexasRawPermits?: (scope: { city: string; state?: string | null }) => Promise<TexasRawPermitResult | null>
  validateGroundingPayload?: GroundingValidationFn
  consumerMarket?: ConsumerMarketDependencies
}

const HISTORY_METRIC_CONFIG: Record<
  AgentHistoryMetric,
  {
    aliases: RegExp[]
    defaultWindow: AgentHistoryTimeWindow
    chartKind: 'line' | 'bar'
    valueFormat: 'currency' | 'percent' | 'number'
  }
> = {
  rent: {
    aliases: [/\brent\b/i, /\bzori\b/i, /\brental\b/i],
    defaultWindow: { mode: 'relative', unit: 'months', value: 24 },
    chartKind: 'line',
    valueFormat: 'currency',
  },
  unemployment_rate: {
    aliases: [/\bunemployment\b/i, /\bjobless\b/i, /\blabor\b/i, /\bemployment rate\b/i],
    defaultWindow: { mode: 'relative', unit: 'months', value: 24 },
    chartKind: 'line',
    valueFormat: 'percent',
  },
  permit_units: {
    aliases: [/\bpermit\b/i, /\bpermits\b/i, /\bconstruction\b/i, /\bbuilding permits?\b/i],
    defaultWindow: { mode: 'relative', unit: 'years', value: 5 },
    chartKind: 'bar',
    valueFormat: 'number',
  },
}

function hasHistoryIntent(userMessage: string): boolean {
  return (
    /\b(history|trend|trends|timeline|over time|time series|changed|change|monthly|month-by-month)\b/i.test(userMessage) ||
    /\b(?:last|past)\s+\d+\s+(?:year|years|month|months)\b/i.test(userMessage)
  )
}

const CORE_RETAIL_PROMPT_PATTERN = /\b(core retail|downtown retail|retail context)\b/i
const CORE_RETAIL_CITY_PATTERN = /\b(austin|houston|dallas|san antonio|el paso)\b/gi
const CORE_RETAIL_COMPARISON_PATTERN = /\b(compare|comparison|versus|vs\.?|between|against)\b/i

function hasPeerComparisonIntent(userMessage: string): boolean {
  return /\b(compare|comparison|versus|vs\.?)\b/i.test(userMessage)
}

function detectHistoryMetric(userMessage: string): AgentHistoryMetric | null {
  const prompt = userMessage.toLowerCase()

  for (const [metric, config] of Object.entries(HISTORY_METRIC_CONFIG) as Array<
    [AgentHistoryMetric, (typeof HISTORY_METRIC_CONFIG)[AgentHistoryMetric]]
  >) {
    if (config.aliases.some((pattern) => pattern.test(prompt))) return metric
  }

  return null
}

function defaultHistoryWindow(metric: AgentHistoryMetric): AgentHistoryTimeWindow {
  return HISTORY_METRIC_CONFIG[metric].defaultWindow
}

function resolveExplicitHistoryWindow(
  userMessage: string,
  metric: AgentHistoryMetric
): AgentHistoryTimeWindow {
  const explicit = userMessage.match(/\b(?:last|past)\s+(\d+)\s+(year|years|month|months)\b/i)
  if (!explicit) return defaultHistoryWindow(metric)

  const value = Number.parseInt(explicit[1] ?? '', 10)
  const rawUnit = (explicit[2] ?? '').toLowerCase()
  if (!Number.isFinite(value) || value <= 0) return defaultHistoryWindow(metric)

  const unit = rawUnit.startsWith('year') ? 'years' : 'months'
  return {
    mode: 'relative',
    unit,
    value,
    label: `Last ${value} ${unit}`,
  }
}

function normalizeHistorySubjectName(value: string): string {
  return value.replace(/,/g, ' ').replace(/\s+/g, ' ').trim()
}

function trimSubjectLeadIn(value: string): string {
  return value.replace(/^.*\b(?:in|of|for|about|at|to)\s+/i, '').trim()
}

function extractHistorySubjectPhrase(prompt: string, subjectToken: 'county' | 'metro'): string | null {
  const tokenPattern = subjectToken === 'metro' ? 'metro(?:\\s+area)?' : 'county'
  const prepositionPattern = new RegExp(`\\b(?:for|in|of|at|about|on|to)\\s+`, 'ig')
  const extractFromTail = (tail: string): string | null => {
    const match = tail.match(new RegExp(`^([A-Za-z][A-Za-z\\s.'-]*?\\s+${tokenPattern})\\b`, 'i'))
    const subject = match?.[1] ? trimSubjectLeadIn(match[1]) : null
    const matchedText = match?.[0] ?? null
    if (!subject) return null

    const remainder = tail
      .slice(matchedText?.length ?? 0)
      .replace(/^[,\s]+/, '')
      .replace(/[.,;:!?]+$/g, '')
      .trim()
    if (!remainder) return subject

    const stateAbbr = normalizeUsStateToAbbr(remainder)
    if (!stateAbbr) return subject

    return `${subject}, ${stateAbbr}`
  }

  for (const preposition of prompt.matchAll(prepositionPattern)) {
    const tail = prompt.slice((preposition.index ?? 0) + preposition[0].length).trim()
    const subject = extractFromTail(tail)
    if (subject) return subject
  }

  return extractFromTail(prompt.trim())
}

const HISTORY_TEXAS_CITY_TO_METRO = new Map<string, string>([
  ['austin', 'Austin'],
  ['houston', 'Houston'],
  ['dallas', 'Dallas'],
  ['san antonio', 'San Antonio'],
])

const HISTORY_TEXAS_CITY_TO_COUNTY_PROXY = new Map<string, string>([
  ['austin', 'Travis County'],
  ['houston', 'Harris County'],
  ['dallas', 'Dallas County'],
  ['san antonio', 'Bexar County'],
])

const AUSTIN_MONTHLY_HISTORY_START_DATE = '2024-01-01'

function resolveTexasCityHistorySubject(prompt: string): AgentHistorySubject | null {
  const parsed = resolveTexasCityHistoryName(prompt)
  if (!parsed) return null

  const cityKey = parsed.cityKey
  const metroName = HISTORY_TEXAS_CITY_TO_METRO.get(cityKey)
  if (!metroName) return null

  return {
    kind: 'metro',
    id: buildMetroAreaKey(metroName, 'TX'),
    label: `${metroName}, TX`,
  }
}

function resolveTexasCityHistoryCountyProxy(prompt: string): AgentHistorySubject | null {
  const parsed = resolveTexasCityHistoryName(prompt)
  if (!parsed) return null

  const cityKey = parsed.cityKey
  const countyName = HISTORY_TEXAS_CITY_TO_COUNTY_PROXY.get(cityKey)
  if (!countyName) return null

  const countyBaseName = countyName.replace(/\s+county$/i, '').trim()
  const cityDisplay = parsed.cityDisplay
  return {
    kind: 'county',
    id: buildCountyAreaKey(countyBaseName, 'TX'),
    label: `${cityDisplay}, TX (${countyName} proxy)`,
  }
}

function resolveTexasCityHistoryName(
  prompt: string
): { cityKey: string; cityDisplay: string } | null {
  const normalizedPrompt = prompt.replace(/\s+/g, ' ').trim()
  for (const [cityKey, cityDisplay] of HISTORY_TEXAS_CITY_TO_METRO.entries()) {
    const pattern = new RegExp(`\\b${cityKey.replace(/\s+/g, '\\s+')}(?:\\s*,\\s*(?:tx|texas))?\\b`, 'i')
    if (pattern.test(normalizedPrompt)) {
      return { cityKey, cityDisplay }
    }
  }

  return null
}

function resolveAustinMonthlyPermitWindow(userMessage: string): AgentHistoryTimeWindow | null {
  const explicit = userMessage.match(/\b(?:last|past)\s+(\d+)\s+(year|years|month|months)\b/i)
  if (!explicit) {
    return {
      mode: 'relative',
      unit: 'months',
      value: 24,
      label: 'Last 24 months',
    }
  }

  const value = Number.parseInt(explicit[1] ?? '', 10)
  const rawUnit = (explicit[2] ?? '').toLowerCase()
  if (!Number.isFinite(value) || value <= 0) return null
  if (rawUnit.startsWith('year')) return null

  return {
    mode: 'relative',
    unit: 'months',
    value,
    label: `Last ${value} months`,
  }
}

function normalizeAustinMonthlyTimeWindow(timeWindow: AgentHistoryTimeWindow): { startDate: string; label: string } {
  if (timeWindow.mode !== 'relative' || timeWindow.unit !== 'months') {
    throw new Error('Austin monthly permit history requires a monthly relative window.')
  }

  const now = new Date()
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - timeWindow.value, 1))
  const isoDate = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, '0')}-01`
  return {
    startDate: isoDate,
    label: timeWindow.label ?? `Last ${timeWindow.value} months`,
  }
}

function bucketAustinPermitsByMonth(
  raw: TexasRawPermitResult,
  startDate: string
): Array<{ x: string; y: number }> {
  const counts = new Map<string, number>()
  const startMonth = startDate.slice(0, 7)

  for (const permit of raw.permits) {
    const issueDate = typeof permit.issue_date === 'string' ? permit.issue_date.trim() : ''
    const month = issueDate.match(/^(\d{4}-\d{2})/)?.[1] ?? null
    if (!month || month < startMonth) continue
    counts.set(month, (counts.get(month) ?? 0) + 1)
  }

  return Array.from(counts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([x, y]) => ({ x, y }))
}

async function maybeBuildAustinMonthlyPermitHistoryResponse(
  userMessage: string,
  metric: AgentHistoryMetric,
  comparisonMarket: AgentHistorySubject | null,
  dependencies: HistoryComparisonDependencies
): Promise<AgentPipelineResult | null> {
  const city = resolveTexasCityHistoryName(userMessage)
  if (!city || city.cityKey !== 'austin' || metric !== 'permit_units' || comparisonMarket) return null

  const timeWindow = resolveAustinMonthlyPermitWindow(userMessage)
  if (!timeWindow) {
    return {
      message: 'Austin permit history is currently limited to monthly raw permit data since January 2024. Try a monthly window like the last 12 months.',
      action: { type: 'none' as const },
      trace: {
        summary: 'Austin permit history is monthly-only for now',
        taskType: 'spot_trends',
        methodology:
          'Scout recognized an Austin-specific permit-history request, but the bounded Austin path currently supports only monthly raw-permit aggregation from the live Austin Open Data source.',
        keyFindings: ['No chart was generated.'],
        evidence: ['Austin raw permit history is served only as monthly event counts from January 2024 onward.'],
        caveats: ['Annual or multi-year Austin city permit history is not wired yet.'],
        nextQuestions: ['Ask for monthly permit activity in Austin.', 'Ask for the last 12 months of permit data for Austin, Texas.'],
      },
      chart: null,
    }
  }

  const normalizedWindow = normalizeAustinMonthlyTimeWindow(timeWindow)
  if (normalizedWindow.startDate < AUSTIN_MONTHLY_HISTORY_START_DATE) {
    return {
      message: 'Austin permit history is currently limited to monthly raw permit data since January 2024. Try a shorter monthly window.',
      action: { type: 'none' as const },
      trace: {
        summary: 'Austin permit history is monthly-only for now',
        taskType: 'spot_trends',
        methodology:
          'Scout recognized an Austin-specific permit-history request, but the bounded Austin path only has raw monthly permit events beginning in January 2024.',
        keyFindings: ['No chart was generated.'],
        evidence: [`Requested window begins before ${AUSTIN_MONTHLY_HISTORY_START_DATE}.`],
        caveats: ['Austin monthly history cannot answer windows earlier than January 2024 yet.'],
        nextQuestions: ['Ask for the last 12 months of permit data for Austin, Texas.', 'Ask for monthly permit activity in Austin.'],
      },
      chart: null,
    }
  }

  const fetchTexasRawPermits =
    dependencies.getTexasRawPermits ??
    (async (scope: { city: string; state?: string | null }) => {
      const { getTexasRawPermits } = await import('@/lib/texas-raw-permits')
      return getTexasRawPermits(scope)
    })

  const raw = await fetchTexasRawPermits({ city: 'Austin', state: 'TX' })
  if (!raw) {
    throw new Error('Austin raw permits are unavailable for the current request.')
  }

  const points = bucketAustinPermitsByMonth(raw, normalizedWindow.startDate)
  if (points.length < 2) {
    return {
      message: 'Austin raw permits did not return enough monthly history to chart for that window.',
      action: { type: 'none' as const },
      trace: {
        summary: 'Insufficient Austin monthly permit history',
        taskType: 'spot_trends',
        methodology:
          'Scout aggregated monthly Austin raw permit events from the live Austin Open Data feed, but the requested window did not produce enough monthly buckets to chart.',
        keyFindings: ['No chart was generated.'],
        evidence: [`Monthly buckets returned: ${points.length}.`],
        caveats: ['Austin monthly history only reflects raw permit events available from January 2024 onward.'],
        nextQuestions: ['Ask for the last 12 months of permit data for Austin, Texas.', 'Ask for monthly permit activity in Austin.'],
      },
      chart: null,
    }
  }

  const firstPoint = points[0]
  const lastPoint = points[points.length - 1]
  const citation: ScoutChartCitation = {
    id: 'austin_raw_permits:monthly',
    label: 'City of Austin Open Data building permits',
    sourceType: 'public_dataset',
    scope: 'Austin, TX',
    note: 'Monthly permit counts aggregated from live Austin raw permit events.',
    periodLabel: `${firstPoint.x} to ${lastPoint.x}`,
  }

  return finalizeAgentPipelineResult({
    message: `Here is the ${normalizedWindow.label.toLowerCase()} monthly permit activity history for Austin, TX.`,
    action: { type: 'none' as const },
    trace: {
      summary: 'Monthly permit activity history for Austin, TX',
      taskType: 'spot_trends',
      methodology:
        'Scout aggregated live Austin raw permit events by issue month from the City of Austin Open Data feed and charted the monthly counts directly.',
      keyFindings: [
        `${points.length} monthly buckets were returned for Austin, TX.`,
        `Monthly permit counts moved from ${firstPoint.y} to ${lastPoint.y} across ${normalizedWindow.label}.`,
      ],
      evidence: [
        'Metric: Monthly permit count.',
        `Window: ${normalizedWindow.label}.`,
        'Source: City of Austin Open Data building permits.',
      ],
      caveats: ['Austin monthly history is currently limited to live raw permit events beginning in January 2024.'],
      nextQuestions: ['Ask for another monthly Austin window.', 'Ask to compare the Austin monthly pattern against recent raw permit events.'],
      citations: [citation],
    },
    chart: normalizeScoutChartOutput({
      kind: 'bar',
      title: 'Austin, TX monthly permit activity',
      subtitle: 'Monthly counts from City of Austin Open Data raw permits',
      summary: 'Grounded monthly Austin permit activity aggregated from live raw permit events.',
      placeholder: false,
      confidenceLabel: 'austin monthly raw permits',
      xAxis: { key: 'period', label: 'Month' },
      yAxis: { label: 'Permit count', valueFormat: 'number' },
      series: [
        {
          key: 'austin:monthly_permits',
          label: 'Austin, TX',
          color: '#D76B3D',
          points,
        },
      ],
      citations: [citation],
    }),
  }, dependencies)
}

function resolveHistorySubjectMarket(
  userMessage: string,
  context: MapContext | null | undefined
): AgentHistorySubject | null {
  const prompt = userMessage.trim()

  const countyPhrase = extractHistorySubjectPhrase(prompt, 'county')
  if (countyPhrase) {
    const parsed = splitTrailingUsState(countyPhrase)
    if (parsed.stateAbbr && parsed.stateAbbr !== 'TX') return null

    const countyBaseName = normalizeHistorySubjectName(parsed.name).replace(/\s+county$/i, '').trim()
    const countyName = normalizeCountyDisplayName(countyBaseName)
    if (!countyName) return null

    return {
      kind: 'county',
      id: buildCountyAreaKey(countyBaseName, 'TX'),
      label: `${countyName}, TX`,
    }
  }

  const metroPhrase = extractHistorySubjectPhrase(prompt, 'metro')
  if (metroPhrase) {
    const parsed = splitTrailingUsState(metroPhrase)
    if (parsed.stateAbbr && parsed.stateAbbr !== 'TX') return null

    const metroName = normalizeMetroDisplayName(normalizeHistorySubjectName(parsed.name))
    if (!metroName) return null

    return {
      kind: 'metro',
      id: buildMetroAreaKey(metroName, 'TX'),
      label: `${metroName}, TX`,
    }
  }

  const texasCitySubject = resolveTexasCityHistorySubject(prompt)
  if (texasCitySubject) return texasCitySubject

  const zip = prompt.match(/\b\d{5}\b/)?.[0] ?? context?.zip?.trim() ?? null
  if (zip) {
    const label = context?.label?.trim() || context?.eda?.geographyLabel?.trim() || zip
    return { kind: 'zip', id: zip, label }
  }

  return null
}

function splitPeerComparisonChunks(userMessage: string): string[] {
  const normalized = userMessage.replace(/\s+/g, ' ').trim()
  const patterns = [
    /^(?:compare|comparison(?:\s+of)?)\s+(.+?)\s+(?:versus|vs\.?|to|and|with)\s+(.+)$/i,
    /^(.+?)\s+compared\s+with\s+(.+)$/i,
  ]

  for (const pattern of patterns) {
    const match = normalized.match(pattern)
    if (!match) continue

    return [match[1], match[2]]
      .map((chunk) => chunk.trim().replace(/^[,.\s]+|[,.\s]+$/g, ''))
      .filter(Boolean)
  }

  return normalized
    .split(/\b(?:versus|vs\.?|to|and|with)\b/i)
    .map((chunk) => chunk.trim().replace(/^[,.\s]+|[,.\s]+$/g, ''))
    .filter(Boolean)
}

function cleanPeerComparisonChunk(chunk: string): string {
  return chunk
    .replace(/^(?:compare|comparison(?:\s+of)?|show me|show)\s+/i, '')
    .replace(/\b(?:this|current)\s+(?:market|zip|county|metro)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasActiveComparisonMarker(userMessage: string): boolean {
  return /\b(?:this|current)\s+(?:market|zip|county|metro)\b/i.test(userMessage)
}

function resolveActiveComparisonSubject(
  context: MapContext | null | undefined
): AgentHistorySubject | null {
  if (context?.activeSubject) return context.activeSubject

  const zip = context?.zip?.trim()
  if (!zip) return null

  return {
    kind: 'zip',
    id: zip,
    label: context?.label?.trim() || context?.eda?.geographyLabel?.trim() || zip,
  }
}

function buildMissingActiveComparisonMarketPayload(): AgentPipelineResult {
  return {
    message: 'I could not use the current workspace as one side of that comparison because there is no active market loaded.',
    action: { type: 'none' as const },
    trace: {
      summary: 'Comparison request missing an active market',
      taskType: 'compare_segments',
      methodology:
        'Scout recognized an active-vs-explicit comparison prompt, but the current workspace did not provide a usable active market.',
      keyFindings: ['No comparison chart was generated.'],
      evidence: ['The bounded active comparison path currently needs an active ZIP in the workspace.'],
      caveats: ['Load a market first, then ask for the comparison again.'],
      nextQuestions: ['Load a ZIP like 78701 and ask to compare it with 77002.'],
    },
    chart: null,
  }
}

function buildUnsupportedComparisonMetricPayload(
  markets: [AgentHistorySubject, AgentHistorySubject]
): AgentPipelineResult {
  const [subjectMarket, comparisonMarket] = markets

  return {
    message: `I understood the comparison between ${subjectMarket.label} and ${comparisonMarket.label}, but that comparison metric is not supported yet. Scout only handles rent, unemployment rate, and permit units for now.`,
    action: { type: 'none' as const },
    trace: {
      summary: 'Unsupported comparison metric',
      taskType: 'compare_segments',
      methodology:
        'Scout resolved both comparison markets from the prompt first, then stopped because the requested comparison metric is outside the bounded grounded set.',
      keyFindings: ['No comparison chart was generated.'],
      evidence: [
        `Resolved market A: ${subjectMarket.label}.`,
        `Resolved market B: ${comparisonMarket.label}.`,
        'Supported grounded comparison metrics currently include rent, unemployment rate, and permit units.',
      ],
      caveats: ['Use one of the supported grounded comparison metrics for now.'],
      nextQuestions: [
        `Ask to compare rent history for ${subjectMarket.label} and ${comparisonMarket.label}.`,
        `Ask to compare permit history or unemployment history for ${subjectMarket.label} and ${comparisonMarket.label}.`,
      ],
    },
    chart: null,
  }
}

function buildUnsupportedCoreRetailComparisonPayload(cities: string[]): AgentPipelineResult {
  const renderedCities = cities.map((city) => formatCoreRetailCityName(city))
  const cityList = renderedCities.length >= 2 ? `${renderedCities[0]} and ${renderedCities[1]}` : renderedCities.join(', ')

  return {
    message: `Core retail comparison currently supports Austin compared with Houston or Dallas only. I could not use ${cityList || 'that pair'} for this bounded path.`,
    action: { type: 'none' as const },
    trace: {
      summary: 'Unsupported core retail comparison pair',
      taskType: 'compare_segments',
      methodology:
        'Scout recognized a bounded current retail-context comparison prompt, but the requested cities are outside the supported Austin-versus-Houston core pair.',
      keyFindings: ['No comparison chart was generated.'],
      evidence: [
        renderedCities.length > 0 ? `Resolved cities: ${renderedCities.join(', ')}.` : 'No explicit cities were resolved.',
        'Supported core retail pairs currently include Austin with Houston or Dallas only.',
      ],
      caveats: ['Use Austin with Houston or Dallas for the bounded current retail comparison path.'],
      nextQuestions: [
        'Ask to compare core retail context for Austin and Houston.',
        'Ask to compare core retail context for Austin and Dallas.',
      ],
    },
    chart: null,
  }
}

function buildUnresolvedCoreRetailComparisonPayload(): AgentPipelineResult {
  return {
    message: 'I could not identify two explicit cities for that core retail comparison.',
    action: { type: 'none' as const },
    trace: {
      summary: 'Core retail comparison missing two cities',
      taskType: 'compare_segments',
      methodology:
        'Scout recognized a bounded core retail comparison prompt, but the prompt did not resolve to two explicit cities.',
      keyFindings: ['No comparison chart was generated.'],
      evidence: ['The bounded core retail path currently needs two explicit cities.'],
      caveats: ['Ask for Austin with Houston or Dallas to use this path.'],
      nextQuestions: [
        'Ask to compare core retail context for Austin and Houston.',
        'Ask to compare core retail context for Austin and Dallas.',
      ],
    },
    chart: null,
  }
}

function formatCoreRetailCityName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\b[a-z]/g, (match) => match.toUpperCase())
}

function resolveCoreRetailPromptCities(userMessage: string): string[] {
  return Array.from(
    new Set((userMessage.match(CORE_RETAIL_CITY_PATTERN) ?? []).map((value) => value.trim().toLowerCase()))
  )
}

function hasCoreRetailComparisonIntent(userMessage: string): boolean {
  const hasRetailKeyword =
    CORE_RETAIL_PROMPT_PATTERN.test(userMessage) ||
    (/\bretail\b/i.test(userMessage) && CORE_RETAIL_COMPARISON_PATTERN.test(userMessage))

  return hasRetailKeyword && (
    CORE_RETAIL_COMPARISON_PATTERN.test(userMessage) ||
    resolveCoreRetailPromptCities(userMessage).length >= 2
  )
}

function pickCoreRetailComparisonCities(cities: string[]): { cityA: string; cityB: string } | null {
  if (cities.length < 2) return null

  const citySet = new Set(cities)
  if (citySet.has('austin') && citySet.has('houston')) {
    return { cityA: 'Austin', cityB: 'Houston' }
  }
  if (citySet.has('austin') && citySet.has('dallas')) {
    return { cityA: 'Austin', cityB: 'Dallas' }
  }

  return null
}

function buildCoreRetailComparisonChart(comparison: CoreRetailComparisonResult): ScoutChartOutput {
  return normalizeScoutChartOutput({
    kind: 'bar',
    title: `${comparison.cityA.label} vs ${comparison.cityB.label} core retail context`,
    subtitle: `Current Overture POI snapshot within a fixed ${comparison.radiusMeters}m radius around each city core.`,
    summary: `Bounded current retail-context comparison for ${comparison.cityA.label} and ${comparison.cityB.label}.`,
    placeholder: false,
    confidenceLabel: 'Overture current snapshot',
    xAxis: { key: 'bucket', label: 'Retail bucket' },
    yAxis: { label: 'POI count', valueFormat: 'number' },
    series: [
      {
        key: comparison.cityA.key,
        label: comparison.cityA.label,
        color: '#D76B3D',
        points: comparison.buckets.map((bucket) => ({ x: bucket.label, y: bucket.cityAValue })),
      },
      {
        key: comparison.cityB.key,
        label: comparison.cityB.label,
        color: '#7A8FA6',
        points: comparison.buckets.map((bucket) => ({ x: bucket.label, y: bucket.cityBValue })),
      },
    ],
    citations: [
      {
        id: `overture:core-retail:${comparison.cityA.key}:${comparison.cityB.key}`,
        label: 'Overture POIs',
        sourceType: 'public_dataset',
        scope: `${comparison.cityA.label} and ${comparison.cityB.label} core anchors`,
        note: `Current snapshot within ${comparison.radiusMeters}m fixed-radius core anchors. https://docs.overturemaps.org/guides/places/`,
      },
    ],
  })
}

function buildCoreRetailComparisonTrace(comparison: CoreRetailComparisonResult): AgentTrace {
  return {
    summary: `${comparison.cityA.label} versus ${comparison.cityB.label} core retail context`,
    taskType: 'compare_segments',
    methodology:
      'Scout matched the prompt to the bounded Overture core-retail comparison path, counted current POIs inside fixed-radius city-core anchors, and grouped them into explicit retail buckets.',
    keyFindings: [
      `Compared ${comparison.buckets.length} bounded retail buckets across both city cores.`,
      `${comparison.cityA.label} and ${comparison.cityB.label} were evaluated with the same ${comparison.radiusMeters}m radius.`,
    ],
    evidence: [
      'Source: Overture current POI snapshot.',
      `Buckets: ${comparison.buckets.map((bucket) => bucket.label).join(', ')}.`,
      'This is a current retail-context comparison, not a historical trend.',
    ],
    caveats: ['This bounded path supports Austin core comparisons against Houston or Dallas only in v1.'],
    nextQuestions: ['Ask which Austin neighborhoods look early but have development demand forming nearby.'],
    citations: [
      {
        id: `overture:core-retail:${comparison.cityA.key}:${comparison.cityB.key}`,
        label: 'Overture POIs',
        sourceType: 'public_dataset',
        scope: `${comparison.cityA.label} and ${comparison.cityB.label} core anchors`,
        note: `Current snapshot within ${comparison.radiusMeters}m fixed-radius core anchors. https://docs.overturemaps.org/guides/places/`,
      },
    ],
  }
}

function buildRetailMacroSubject(cityLabel: string): AgentHistorySubject {
  return {
    kind: 'metro',
    id: buildMetroAreaKey(cityLabel, 'TX'),
    label: `${cityLabel}, TX`,
  }
}

function buildPopulationComparisonChart(args: {
  cityA: { label: string; value: number; citation: ScoutChartCitation | null; periodLabel?: string | null }
  cityB: { label: string; value: number; citation: ScoutChartCitation | null; periodLabel?: string | null }
}): ScoutChartOutput {
  return normalizeScoutChartOutput({
    kind: 'bar',
    title: `${args.cityA.label} vs ${args.cityB.label} population`,
    subtitle: 'Bounded public macro comparison',
    summary: 'Current bounded population comparison for the same cities used in the retail context chart.',
    xAxis: { key: 'city', label: 'City' },
    yAxis: { label: 'Population', valueFormat: 'number' },
    series: [
      {
        key: 'population',
        label: 'Population',
        color: '#7A8FA6',
        points: [
          { x: args.cityA.label, y: args.cityA.value },
          { x: args.cityB.label, y: args.cityB.value },
        ],
      },
    ],
    citations: [args.cityA.citation, args.cityB.citation].filter(
      (citation): citation is ScoutChartCitation => citation != null
    ),
  })
}

function buildPublicMacroComparisonStats(args: {
  title: string
  leftLabel: string
  leftValue: string
  rightLabel: string
  rightValue: string
  leftNote?: string | null
  rightNote?: string | null
}): AgentCompanionOutput {
  return {
    kind: 'stats',
    title: args.title,
    items: [
      { label: args.leftLabel, value: args.leftValue, note: args.leftNote ?? null },
      { label: args.rightLabel, value: args.rightValue, note: args.rightNote ?? null },
    ],
  }
}

async function buildRetailMacroCompanions(
  comparison: CoreRetailComparisonResult,
  getPublicMacroEvidence: (query: AgentPublicMacroQuery) => Promise<AgentPublicMacroEvidenceResult>
): Promise<AgentCompanionOutput[]> {
  async function buildCompanion(metric: AgentPublicMacroMetric): Promise<AgentCompanionOutput | null> {
    const subjectA = buildRetailMacroSubject(comparison.cityA.label)
    const subjectB = buildRetailMacroSubject(comparison.cityB.label)

    const [left, right] = await Promise.all([
      getPublicMacroEvidence({ metric, subject: subjectA }),
      getPublicMacroEvidence({ metric, subject: subjectB }),
    ])

    if (metric === 'population') {
      return {
        kind: 'chart',
        chart: buildPopulationComparisonChart({
          cityA: {
            label: comparison.cityA.label,
            value: left.value.value,
            citation: left.citations[0] ?? null,
            periodLabel: left.value.periodLabel,
          },
          cityB: {
            label: comparison.cityB.label,
            value: right.value.value,
            citation: right.citations[0] ?? null,
            periodLabel: right.value.periodLabel,
          },
        }),
      }
    }

    return buildPublicMacroComparisonStats({
      title: 'Median household income',
      leftLabel: comparison.cityA.label,
      leftValue: left.value.displayValue,
      rightLabel: comparison.cityB.label,
      rightValue: right.value.displayValue,
      leftNote: left.value.periodLabel,
      rightNote: right.value.periodLabel,
    })
  }

  return (
    await Promise.all([
      buildCompanion('population').catch(() => null),
      buildCompanion('median household income').catch(() => null),
    ])
  ).filter((entry): entry is AgentCompanionOutput => entry != null)
}

async function maybeBuildCoreRetailComparisonResponse(
  userMessage: string,
  dependencies: HistoryComparisonDependencies = {}
): Promise<AgentPipelineResult | null> {
  if (!hasCoreRetailComparisonIntent(userMessage)) return null

  const cities = resolveCoreRetailPromptCities(userMessage)
  if (cities.length < 2) {
    return buildUnresolvedCoreRetailComparisonPayload()
  }

  const supportedCities = pickCoreRetailComparisonCities(cities)
  if (!supportedCities) {
    return buildUnsupportedCoreRetailComparisonPayload(cities)
  }

  const getCoreRetailComparison = dependencies.getCoreRetailComparison ?? buildCoreRetailComparison
  const getPublicMacroEvidence = dependencies.getPublicMacroEvidence ?? retrievePublicMacroEvidence
  const comparison = await getCoreRetailComparison(supportedCities)
  const chart = buildCoreRetailComparisonChart(comparison)
  const trace = buildCoreRetailComparisonTrace(comparison)
  const companionOutputs = await buildRetailMacroCompanions(comparison, getPublicMacroEvidence)

  return {
    message: `Here is the current core retail context comparison for ${comparison.cityA.label} and ${comparison.cityB.label}.`,
    action: { type: 'none' as const },
    trace,
    chart,
    companionOutputs,
  }
}

function buildConsumerMarketFailurePayload(error: unknown): AgentPipelineResult {
  const reason = error instanceof Error ? error.message : 'One of the evidence fetches failed.'
  return {
    message: `I recognized a consumer-market comparison but could not ground it: ${reason}`,
    action: { type: 'none' as const },
    trace: {
      summary: 'Consumer-market comparison could not be grounded',
      taskType: 'compare_segments',
      methodology:
        'Scout planned an agentic consumer-market comparison, but one of the live evidence fetches (Census ACS, geocoding, or Overture POIs) did not return usable values, so no charts were generated.',
      keyFindings: ['No comparison charts were generated.'],
      evidence: [reason],
      caveats: ['The ACS 1-year place series only covers cities with 65k+ residents.'],
      nextQuestions: ['Try two larger US cities, like Austin vs Houston.'],
    },
    chart: null,
  }
}

/**
 * Agentic consumer-market path: Gemini plans the comparison, live tools (Census ACS,
 * geocoding, Overture POIs) fetch the evidence, and Gemini synthesizes the takeaways.
 * Generalizes across business types and ACS-covered US cities.
 */
async function maybeBuildConsumerMarketComparisonResponse(
  userMessage: string,
  dependencies: HistoryComparisonDependencies = {}
): Promise<AgentPipelineResult | null> {
  if (!hasConsumerMarketComparisonIntent(userMessage)) return null
  if (!process.env.GEMINI_API_KEY && !dependencies.consumerMarket?.generateJson) return null

  try {
    const outcome = await buildConsumerMarketComparison(userMessage, dependencies.consumerMarket)
    if (!outcome) return null
    return {
      message: outcome.message,
      action: { type: 'none' as const },
      trace: outcome.trace,
      chart: outcome.chart,
      companionOutputs: outcome.companionOutputs,
    }
  } catch (error) {
    return buildConsumerMarketFailurePayload(error)
  }
}

function buildUnresolvedPeerComparisonPayload(): AgentPipelineResult {
  return {
    message: 'I could not identify two explicit comparison markets from that prompt.',
    action: { type: 'none' as const },
    trace: {
      summary: 'Comparison request missing two resolvable markets',
      taskType: 'compare_segments',
      methodology:
        'Scout recognized an explicit comparison request, but it could not resolve two supported markets from the prompt.',
      keyFindings: ['No comparison chart was generated.'],
      evidence: ['The bounded comparison path needs two explicit ZIP, Texas county, or Texas metro markets.'],
      caveats: ['Use two explicitly named markets of the same kind for now.'],
      nextQuestions: [
        'Ask to compare two ZIPs like 78701 and 77002.',
        'Ask to compare two Texas counties like Harris County and Travis County.',
      ],
    },
    chart: null,
  }
}

function resolvePeerComparisonMarkets(
  userMessage: string
): [AgentHistorySubject, AgentHistorySubject] | null {
  const chunks = splitPeerComparisonChunks(userMessage)
  const subjects: AgentHistorySubject[] = []

  for (const chunk of chunks) {
    const subject = resolveHistorySubjectMarket(cleanPeerComparisonChunk(chunk), null)
    if (!subject) continue
    if (subjects.some((existing) => existing.kind === subject.kind && existing.id === subject.id)) continue
    subjects.push(subject)
    if (subjects.length === 2) break
  }

  if (subjects.length >= 2) {
    return [subjects[0], subjects[1]]
  }

  const explicitZips = Array.from(new Set(userMessage.match(/\b\d{5}\b/g) ?? []))
  if (explicitZips.length >= 2) {
    return explicitZips.slice(0, 2).map((zip) => ({ kind: 'zip', id: zip, label: zip })) as [
      AgentHistorySubject,
      AgentHistorySubject,
    ]
  }

  return null
}

function resolveActiveVsExplicitComparisonMarkets(
  userMessage: string,
  context: MapContext | null | undefined
): [AgentHistorySubject, AgentHistorySubject] | null {
  if (!hasActiveComparisonMarker(userMessage)) return null

  const activeSubject = resolveActiveComparisonSubject(context)
  if (!activeSubject) return null

  const cleanedPrompt = userMessage
    .replace(/\b(?:this|current)\s+(?:market|zip|county|metro)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()

  const chunks = splitPeerComparisonChunks(cleanedPrompt)
  for (const chunk of chunks) {
    const subject = resolveHistorySubjectMarket(cleanPeerComparisonChunk(chunk), null)
    if (!subject) continue
    if (subject.kind !== activeSubject.kind || subject.id === activeSubject.id) continue
    return [activeSubject, subject]
  }

  const explicitZip = Array.from(new Set(userMessage.match(/\b\d{5}\b/g) ?? [])).find((zip) => zip !== activeSubject.id)
  if (!explicitZip) return null

  return [activeSubject, { kind: 'zip', id: explicitZip, label: explicitZip }]
}

function buildHistoryComparisonRequest(
  metric: AgentHistoryMetric,
  subjectMarket: AgentHistorySubject,
  timeWindow: AgentHistoryTimeWindow
): AnalyticalComparisonRequest {
  return {
    comparisonMode: 'history',
    metric,
    subjectMarket,
    comparisonMarket: null,
    timeWindow,
  }
}

function buildHistoryChartFromComparison(comparison: AnalyticalComparisonResult): ScoutChartOutput {
  const series = comparison.series.map((entry) => ({
    key: entry.key,
    label: entry.label,
    color: '#D76B3D',
    points: entry.points.map((point) => ({ x: point.x, y: point.y })),
  }))
  const title =
    comparison.comparisonMode === 'peer_market' && comparison.series.length >= 2
      ? `${comparison.metricLabel} comparison: ${comparison.series[0]?.label ?? 'Market A'} vs ${comparison.series[1]?.label ?? 'Market B'}`
      : `${comparison.series[0]?.label ?? 'Market'} ${comparison.metricLabel.toLowerCase()} history`
  const summary =
    comparison.comparisonMode === 'peer_market' && comparison.series.length >= 2
      ? `Grounded ${comparison.metricLabel.toLowerCase()} comparison for ${comparison.series[0]?.label ?? 'Market A'} versus ${comparison.series[1]?.label ?? 'Market B'}.`
      : `Grounded ${comparison.metricLabel.toLowerCase()} history for ${comparison.series[0]?.label ?? 'the selected market'}.`
  const subtitle =
    comparison.comparisonMode === 'peer_market'
      ? 'Peer-market series from the shared market-data router'
      : 'Historical series from the shared market-data router'

  return normalizeScoutChartOutput({
    kind: HISTORY_METRIC_CONFIG[comparison.metric].chartKind,
    title,
    subtitle,
    summary,
    placeholder: false,
    confidenceLabel: 'router-backed history',
    xAxis: { key: 'period', label: 'Period' },
    yAxis: { label: comparison.metricLabel, valueFormat: HISTORY_METRIC_CONFIG[comparison.metric].valueFormat },
    series,
    citations: comparison.citations,
  })
}

function buildHistoryTrace(comparison: AnalyticalComparisonResult): AgentTrace {
  const subjectLabel = comparison.series[0]?.label ?? 'the selected market'
  const firstPoint = comparison.series[0]?.points[0] ?? null
  const lastPoint = comparison.series[0]?.points[comparison.series[0]?.points.length - 1] ?? null
  const comparisonLabel = comparison.series[1]?.label ?? null
  const comparisonLastPoint = comparison.series[1]?.points[comparison.series[1]?.points.length - 1] ?? null

  if (comparison.comparisonMode === 'peer_market' && comparisonLabel) {
    return {
      summary: `${comparison.metricLabel} comparison for ${subjectLabel} versus ${comparisonLabel}`,
      taskType: 'compare_segments',
      methodology:
        'Scout normalized the comparison request, delegated both historical reads to the comparison-ready market-data router, and rendered the returned series without inventing any intermediate values.',
      keyFindings: [
        `${comparison.series.length} grounded historical series were returned for the comparison.`,
        comparisonLastPoint && lastPoint
          ? `Latest ${comparison.metricLabel.toLowerCase()} is ${lastPoint.y} for ${subjectLabel} versus ${comparisonLastPoint.y} for ${comparisonLabel}.`
          : `Scout returned grounded comparative history for both markets.`,
      ],
      evidence: [
        `Metric: ${comparison.metricLabel}.`,
        `Window: ${comparison.timeWindow.label}.`,
        `Markets: ${subjectLabel} and ${comparisonLabel}.`,
      ],
      caveats: ['Only rent, unemployment rate, and permit history are supported in this bounded comparative path.'],
      nextQuestions: ['Ask for another pair of ZIPs, counties, or metros if you want a different comparison.'],
      citations: comparison.citations,
    }
  }

  return {
    summary: `${comparison.metricLabel} history for ${subjectLabel}`,
    taskType: 'spot_trends',
    methodology:
      'Scout normalized the history request, delegated the historical read to the comparison-ready market-data router, and rendered the returned series without inventing any intermediate values.',
    keyFindings: [
      `${comparison.series[0]?.points.length ?? 0} historical points were returned for ${subjectLabel}.`,
      firstPoint && lastPoint
        ? `${comparison.metricLabel} moved from ${firstPoint.y} to ${lastPoint.y} across ${comparison.timeWindow.label}.`
        : `${comparison.metricLabel} history was available from the router.`,
    ],
    evidence: [
      `Metric: ${comparison.metricLabel}.`,
      `Window: ${comparison.timeWindow.label}.`,
      comparison.citations[0]?.label ? `Source: ${comparison.citations[0].label}.` : 'Source: router-backed historical series.',
      ...(comparison.debug?.historySources[0]
        ? [
            `Debug source selection: ${comparison.debug.historySources[0].selectedSourceId ?? 'none'} (${comparison.debug.historySources[0].selectedSourceLabel ?? 'n/a'}).`,
            `Debug specialized rows found: ${comparison.debug.historySources[0].specializedRowsFound}.`,
            `Debug fallback used: ${comparison.debug.historySources[0].fallbackUsed ? 'yes' : 'no'}.`,
            `Debug final source: ${comparison.debug.historySources[0].finalSourceId} (${comparison.debug.historySources[0].finalSourceLabel}).`,
          ]
        : []),
    ],
    caveats: ['Only rent, unemployment rate, and permit history are supported in this bounded path.'],
    nextQuestions: ['Ask for another ZIP, county, or metro if you want a comparison against a different market.'],
    citations: comparison.citations,
  }
}

function trimCitationText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeScoutCitationSourceType(value: unknown): ScoutChartCitation['sourceType'] | null {
  const normalized = trimCitationText(value)
  if (
    normalized === 'internal_dataset' ||
    normalized === 'public_dataset' ||
    normalized === 'workspace_upload' ||
    normalized === 'derived' ||
    normalized === 'placeholder'
  ) {
    return normalized
  }

  return null
}

function mergeScoutChartCitationSets(
  primary: readonly (Partial<ScoutChartCitation> | null | undefined)[],
  secondary: readonly (Partial<ScoutChartCitation> | null | undefined)[]
): ScoutChartCitation[] {
  const merged = new Map<string, Partial<ScoutChartCitation>>()

  for (const citation of primary) {
    const id = trimCitationText(citation?.id)
    if (!id) continue
    merged.set(id, {
      id,
      label: trimCitationText(citation?.label),
      sourceType: normalizeScoutCitationSourceType(citation?.sourceType) ?? 'derived',
      scope: trimCitationText(citation?.scope) || null,
      note: trimCitationText(citation?.note) || null,
      periodLabel: trimCitationText(citation?.periodLabel) || null,
      placeholder: citation?.placeholder === true,
    })
  }

  for (const citation of secondary) {
    const id = trimCitationText(citation?.id)
    if (!id) continue

    const existing = merged.get(id)
    if (!existing) {
      merged.set(id, {
        id,
        label: trimCitationText(citation?.label),
        sourceType: normalizeScoutCitationSourceType(citation?.sourceType) ?? 'derived',
        scope: trimCitationText(citation?.scope) || null,
        note: trimCitationText(citation?.note) || null,
        periodLabel: trimCitationText(citation?.periodLabel) || null,
        placeholder: citation?.placeholder === true,
      })
      continue
    }

    merged.set(id, {
      ...existing,
      label: trimCitationText(existing.label) || trimCitationText(citation?.label),
      sourceType:
        normalizeScoutCitationSourceType(existing.sourceType) ??
        normalizeScoutCitationSourceType(citation?.sourceType) ??
        'derived',
      scope: trimCitationText(existing.scope) || trimCitationText(citation?.scope) || null,
      note: trimCitationText(existing.note) || trimCitationText(citation?.note) || null,
      periodLabel: trimCitationText(existing.periodLabel) || trimCitationText(citation?.periodLabel) || null,
      placeholder: existing.placeholder === true || citation?.placeholder === true,
    })
  }

  return Array.from(merged.values()).map((citation) => ({
    id: trimCitationText(citation.id),
    label: trimCitationText(citation.label),
    sourceType: normalizeScoutCitationSourceType(citation.sourceType) ?? 'derived',
    scope: trimCitationText(citation.scope) || null,
    note: trimCitationText(citation.note) || null,
    periodLabel: trimCitationText(citation.periodLabel) || null,
    placeholder: citation.placeholder === true,
  }))
}

function hasCompleteScoutChartCitation(citation: Partial<ScoutChartCitation> | null | undefined): boolean {
  const sourceType = normalizeScoutCitationSourceType(citation?.sourceType)
  return (
    trimCitationText(citation?.id).length > 0 &&
    trimCitationText(citation?.label).length > 0 &&
    trimCitationText(citation?.periodLabel).length > 0 &&
    sourceType !== 'placeholder' &&
    sourceType != null
  )
}

function toAnalyticalComparisonCitations(
  citations: readonly ScoutChartCitation[]
): AnalyticalComparisonResult['citations'] {
  return citations.flatMap((citation) => {
    const sourceType = normalizeScoutCitationSourceType(citation.sourceType)
    if (!sourceType || sourceType === 'placeholder') return []

    return [{
      id: trimCitationText(citation.id),
      label: trimCitationText(citation.label),
      sourceType,
      note: trimCitationText(citation.note) || null,
      periodLabel: trimCitationText(citation.periodLabel) || null,
    }]
  })
}

function buildInternalEvidenceQuery(
  comparison: AnalyticalComparisonResult,
  subject: AgentHistorySubject
): AgentInternalProvenanceQuery {
  const sourceIds = comparison.citations
    .map((citation) => citation.id.trim())
    .filter((id) => /^(projectr_master_data|projectr_upload|texas_permits):/i.test(id))

  return {
    taskType: comparison.comparisonMode === 'peer_market' ? 'compare_segments' : 'spot_trends',
    metric: comparison.metric,
    subject,
    ...(sourceIds.length > 0 ? { sourceIds } : {}),
  }
}

async function getInternalEvidenceForHistoryComparison(
  comparison: AnalyticalComparisonResult,
  dependencies: HistoryComparisonDependencies,
  fallbackSubject: AgentHistorySubject
): Promise<AgentInternalEvidenceResult> {
  const fetchInternalEvidence =
    dependencies.getInternalEvidence ??
    (async (query: AgentInternalProvenanceQuery) => retrieveInternalEvidence(query))

  const subjects = comparison.series
    .map((entry) => entry.subject)
    .filter(
      (subject, index, all) =>
        all.findIndex((candidate) => candidate.kind === subject.kind && candidate.id === subject.id) === index
    )

  let provenanceResults: AgentInternalEvidenceResult[]
  try {
    provenanceResults = await Promise.all(
      (subjects.length > 0 ? subjects : [fallbackSubject]).map((subject) =>
        fetchInternalEvidence(buildInternalEvidenceQuery(comparison, subject))
      )
    )
  } catch {
    return {
      query: buildInternalEvidenceQuery(comparison, fallbackSubject),
      records: [],
      citations: [],
    }
  }

  return provenanceResults.reduce<AgentInternalEvidenceResult>(
    (acc, result) => ({
      query: acc.query,
      records: [...acc.records, ...result.records],
      citations: [...acc.citations, ...result.citations],
    }),
    {
      query: buildInternalEvidenceQuery(comparison, fallbackSubject),
      records: [],
      citations: [],
    }
  )
}

function buildUnsupportedHistoryPayload(message: string): AgentPipelineResult {
  return {
    message,
    action: { type: 'none' as const },
    trace: {
      summary: 'Unsupported history request',
      taskType: 'explain_metric',
      methodology:
        'Scout recognized a history-style prompt, but the bounded history lane only supports rent, unemployment rate, and permit units.',
      keyFindings: ['No history chart was generated.'],
      evidence: ['The requested metric is outside the supported history metric set.'],
      caveats: ['Try rent, unemployment rate, or permit history instead.'],
      nextQuestions: ['Ask for a supported history metric on the current ZIP, county, or metro.'],
    },
    chart: null,
  }
}

function hasPublicMacroIntent(userMessage: string): boolean {
  return /\b(what(?:'s|\s+is)?|how much(?:\s+is|\s+are)?|tell me|show me|give me|report|estimate|what are)\b/i.test(userMessage)
}

function detectPublicMacroMetric(userMessage: string): AgentPublicMacroMetric | null {
  const prompt = userMessage.toLowerCase()

  if (/\bpopulation\b/i.test(prompt)) return 'population'
  if (/\b(?:median\s+household\s+income|household\s+income)\b/i.test(prompt)) return 'median household income'
  if (/\b(?:housing\s+cost\s+burden|housing\s+burden|cost\s+burden|rent\s+burden)\b/i.test(prompt)) return 'housing cost burden'

  return null
}

function buildPublicMacroTrace(result: AgentPublicMacroEvidenceResult): AgentTrace {
  return {
    summary: `Public macro ${result.value.label} for ${result.value.scope}`,
    taskType: 'explain_metric',
    methodology:
      'Scout resolved the bounded public macro prompt, fetched the requested public evidence, and rendered the returned value without inventing any data.',
    keyFindings: [`${result.value.label} for ${result.value.scope} is ${result.value.displayValue}.`],
    evidence: [
      `Metric: ${result.value.label}.`,
      `Scope: ${result.value.scope}.`,
      `Period: ${result.value.periodLabel}.`,
      result.value.note ? `Note: ${result.value.note}.` : 'The public macro source returned a bounded cited value.',
    ],
    caveats: ['Only population, median household income, and housing cost burden are supported in this bounded public macro lane.'],
    nextQuestions: ['Ask for another Texas ZIP, county, or metro if you want the same public macro metric elsewhere.'],
    citations: result.citations,
  }
}

function buildUnsupportedPublicMacroPayload(subject: AgentHistorySubject | null): AgentPipelineResult {
  const subjectLabel = subject?.label ?? 'that geography'

  return {
    message: `I understood the public macro question for ${subjectLabel}, but that metric is not supported yet. Scout only handles population, median household income, and housing cost burden for now.`,
    action: { type: 'none' as const },
    trace: {
      summary: 'Unsupported public macro metric',
      taskType: 'explain_metric',
      methodology:
        'Scout recognized a public macro prompt, resolved the geography, and stopped because the requested macro metric is outside the bounded public grounding set.',
      keyFindings: ['No public macro chart was generated.'],
      evidence: [
        subject ? `Resolved geography: ${subject.label}.` : 'No Texas geography could be resolved.',
        'Supported public macro metrics currently include population, median household income, and housing cost burden.',
      ],
      caveats: ['Use one of the supported public macro metrics for now.'],
      nextQuestions: [
        subject
          ? `Ask for population, median household income, or housing cost burden for ${subject.label}.`
          : 'Ask for one of the supported public macro metrics on a Texas ZIP, county, or metro.',
      ],
    },
    chart: null,
  }
}

function buildUnresolvedPublicMacroPayload(): AgentPipelineResult {
  return {
    message: 'I could not identify a Texas ZIP, county, or metro for that public macro question.',
    action: { type: 'none' as const },
    trace: {
      summary: 'Public macro request missing a resolvable geography',
      taskType: 'explain_metric',
      methodology:
        'Scout recognized a public macro prompt, but the bounded public grounding lane could not resolve a supported Texas geography from the prompt or current workspace.',
      keyFindings: ['No public macro chart was generated.'],
      evidence: ['The public macro lane needs a Texas ZIP, county, or metro subject.'],
      caveats: ['Try naming the geography directly or load the market first.'],
      nextQuestions: ['Ask for population in Harris County, TX.', 'Ask for median household income in 78701.', 'Ask for housing cost burden in Austin metro.'],
    },
    chart: null,
  }
}

function buildPublicMacroFailurePayload(subject: AgentHistorySubject | null): AgentPipelineResult {
  const subjectLabel = subject?.label ?? 'that geography'

  return {
    message: `I could not verify that public macro fact for ${subjectLabel} from the current grounded data.`,
    action: { type: 'none' as const },
    trace: {
      summary: 'Public macro retrieval failed',
      taskType: 'explain_metric',
      methodology:
        'Scout recognized a supported public macro prompt, but the bounded public grounding adapter failed before it could return a verifiable value.',
      keyFindings: ['No public macro chart was generated.'],
      evidence: [`The public macro adapter could not verify the requested fact for ${subjectLabel}.`],
      caveats: ['Retry the request or ask for a different supported Texas subject.'],
      nextQuestions: ['Ask again for the same macro fact.', 'Try a different Texas ZIP, county, or metro.'],
    },
    chart: null,
  }
}

const DRIVE_TIME_PLACE_PATTERN = /\b(?:drive\s*time|travel\s*time|routing|route|directions?|commute)\b/i
const PLACE_INTENT_PATTERN = /\b(?:where(?:'s|\s+is|\s+are)?|coordinates?|longitude|latitude|lat(?:itude)?|lng|locat(?:ed|ion)|place|map)\b/i
const DRIVE_TIME_METRO_ALIASES = new Set(['austin', 'dallas', 'houston', 'san antonio'])

function hasPlaceIntent(userMessage: string): boolean {
  return PLACE_INTENT_PATTERN.test(userMessage)
}

function looksLikeDriveTimePlacePrompt(userMessage: string): boolean {
  return DRIVE_TIME_PLACE_PATTERN.test(userMessage)
}

function cleanPlacePrompt(userMessage: string): string {
  return userMessage
    .replace(
      /^(?:where(?:'s|\s+is|\s+are)?|what(?:'s|\s+is)?\s+the\s+coordinates?(?:\s+for)?|coordinates?(?:\s+for)?|latitude(?:\s+and\s+longitude)?(?:\s+for)?|give me (?:the\s+)?coordinates(?:\s+for)?|give me (?:the\s+)?location(?:\s+of)?|location(?:\s+of)?|locat(?:ed|ion)(?:\s+of|\s+in|\s+at)?|place(?:\s+of)?|map(?:\s+of)?|show me(?:\s+the)?\s+coordinates(?:\s+for)?|show me(?:\s+the)?\s+location(?:\s+of)?)\s+/i,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim()
}

function resolvePlaceGroundingSubject(
  userMessage: string,
  context: MapContext | null | undefined
): AgentHistorySubject | null {
  const explicitSubject = resolveHistorySubjectMarket(cleanPlacePrompt(userMessage), context)
  if (explicitSubject) return explicitSubject

  if (!hasPlaceIntent(userMessage)) return null

  return resolveActiveComparisonSubject(context)
}

function splitDriveTimeChunks(userMessage: string): string[] {
  const normalized = userMessage.replace(/\s+/g, ' ').trim()
  const patterns = [
    /(?:drive\s*time|travel\s*time|commute|route|routing|directions?).*?\bfrom\b\s+(.+?)\s+\bto\b\s+(.+)$/i,
    /(?:drive\s*time|travel\s*time|commute|route|routing|directions?).*?\bbetween\b\s+(.+?)\s+\band\b\s+(.+)$/i,
    /^(.+?)\s+\bto\b\s+(.+?)\s+(?:drive\s*time|travel\s*time|commute|route|routing|directions?)$/i,
  ]

  for (const pattern of patterns) {
    const match = normalized.match(pattern)
    if (!match) continue

    return [match[1], match[2]]
      .map((chunk) => chunk.trim().replace(/^[,.\s]+|[,.\s]+$/g, ''))
      .filter(Boolean)
  }

  return []
}

function cleanDriveTimeChunk(chunk: string): string {
  return chunk
    .replace(/^(?:drive\s*time|travel\s*time|commute|route|routing|directions?)\s+(?:from|between)?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function resolveDriveTimeSubjectChunk(
  chunk: string,
  context: MapContext | null | undefined
): AgentHistorySubject | null {
  if (/\b(?:this|current)\s+(?:market|zip|county|metro)\b/i.test(chunk)) {
    return resolveActiveComparisonSubject(context)
  }

  const explicitSubject = resolveHistorySubjectMarket(cleanDriveTimeChunk(chunk), null)
  if (explicitSubject) return explicitSubject

  const parsed = splitTrailingUsState(cleanDriveTimeChunk(chunk))
  if (parsed.stateAbbr && parsed.stateAbbr !== 'TX') return null

  const metroName = normalizeMetroDisplayName(normalizeHistorySubjectName(parsed.name))
  if (!metroName) return null

  if (!DRIVE_TIME_METRO_ALIASES.has(metroName.toLowerCase())) return null

  return {
    kind: 'metro',
    id: buildMetroAreaKey(metroName, 'TX'),
    label: `${metroName}, TX`,
  }
}

function resolveDriveTimeMarkets(
  userMessage: string,
  context: MapContext | null | undefined
): [AgentHistorySubject, AgentHistorySubject] | null {
  const chunks = splitDriveTimeChunks(userMessage)
  if (chunks.length >= 2) {
    const subjects: AgentHistorySubject[] = []

    for (const chunk of chunks) {
      const subject = resolveDriveTimeSubjectChunk(chunk, context)
      if (!subject) continue
      subjects.push(subject)
      if (subjects.length === 2) break
    }

    if (subjects.length >= 2) {
      return [subjects[0], subjects[1]]
    }
  }

  return resolveActiveVsExplicitComparisonMarkets(userMessage, context) ?? resolvePeerComparisonMarkets(userMessage)
}

function buildMissingActiveDriveTimePayload(): AgentPipelineResult {
  return {
    message: 'I could not use the current workspace as one side of that drive-time request because there is no active market loaded.',
    action: { type: 'none' as const },
    trace: {
      summary: 'Drive-time request missing an active market',
      taskType: 'explain_metric',
      methodology:
        'Scout recognized an active-vs-explicit drive-time prompt, but the current workspace did not provide a usable active market.',
      keyFindings: ['No drive-time response was generated.'],
      evidence: ['The bounded drive-time path needs an active ZIP, county, or metro when the prompt refers to the current market.'],
      caveats: ['Load a market first, then ask for the drive time again.'],
      nextQuestions: ['Load a Texas ZIP, county, or metro and retry the drive-time request.'],
    },
    chart: null,
  }
}

function buildUnresolvedDriveTimePayload(): AgentPipelineResult {
  return {
    message: 'I could not identify two Texas ZIP, county, or metro subjects for that drive-time request.',
    action: { type: 'none' as const },
    trace: {
      summary: 'Drive-time request missing two resolvable geographies',
      taskType: 'explain_metric',
      methodology:
        'Scout recognized a drive-time prompt, but the bounded drive-time lane could not resolve two supported Texas subjects from the prompt or current workspace.',
      keyFindings: ['No drive-time response was generated.'],
      evidence: ['The drive-time lane needs two Texas ZIP, county, or metro subjects.'],
      caveats: ['Try naming both geographies directly or load the active market first.'],
      nextQuestions: ['Ask for the drive time from Austin metro, TX to Dallas metro, TX.', 'Ask for the commute from this market to Dallas metro, TX after loading the market first.'],
    },
    chart: null,
  }
}

function buildDriveTimeFailurePayload(
  markets: [AgentHistorySubject, AgentHistorySubject] | null
): AgentPipelineResult {
  const scope = markets ? `${markets[0].label} and ${markets[1].label}` : 'those markets'

  return {
    message: `I could not verify that drive-time estimate for ${scope} from the current grounded data.`,
    action: { type: 'none' as const },
    trace: {
      summary: 'Drive-time grounding retrieval failed',
      taskType: 'explain_metric',
      methodology:
        'Scout recognized a supported drive-time prompt, but the bounded route grounding adapter failed before it could return a verifiable estimate.',
      keyFindings: ['No drive-time response was generated.'],
      evidence: [`The drive-time grounding adapter could not verify the requested route estimate for ${scope}.`],
      caveats: ['Retry the request or ask for a different supported Texas route.'],
      nextQuestions: ['Ask again for the same drive-time estimate.', 'Try a different Texas ZIP, county, or metro pair.'],
    },
    chart: null,
  }
}

function buildUnresolvedPlacePayload(): AgentPipelineResult {
  return {
    message: 'I could not identify a Texas ZIP, county, or metro for that place question.',
    action: { type: 'none' as const },
    trace: {
      summary: 'Place request missing a resolvable geography',
      taskType: 'explain_metric',
      methodology:
        'Scout recognized a place prompt, but the bounded place grounding lane could not resolve a supported Texas subject from the prompt or current workspace.',
      keyFindings: ['No place response was generated.'],
      evidence: ['The place lane needs a Texas ZIP, county, or metro subject.'],
      caveats: ['Try naming the geography directly or load the market first.'],
      nextQuestions: ['Ask where Harris County, TX is.', 'Ask for the coordinates of Austin metro, TX.'],
    },
    chart: null,
  }
}

function buildPlaceFailurePayload(subject: AgentHistorySubject | null): AgentPipelineResult {
  const subjectLabel = subject?.label ?? 'that geography'

  return {
    message: `I could not verify that place fact for ${subjectLabel} from the current grounded data.`,
    action: { type: 'none' as const },
    trace: {
      summary: 'Place grounding retrieval failed',
      taskType: 'explain_metric',
      methodology:
        'Scout recognized a supported place prompt, but the bounded place grounding adapter failed before it could return a verifiable value.',
      keyFindings: ['No place response was generated.'],
      evidence: [`The place grounding adapter could not verify the requested fact for ${subjectLabel}.`],
      caveats: ['Retry the request or ask for a different supported Texas subject.'],
      nextQuestions: ['Ask again for the same place fact.', 'Try a different Texas ZIP, county, or metro.'],
    },
    chart: null,
  }
}

function buildPlaceTrace(result: AgentPlaceGroundingEvidenceResult): AgentTrace {
  const coordinates =
    Number.isFinite(result.value.lat) && Number.isFinite(result.value.lng)
      ? `${result.value.lat!.toFixed(4)}, ${result.value.lng!.toFixed(4)}`
      : null

  return {
    summary: `Place grounding for ${result.value.scope}`,
    taskType: 'explain_metric',
    methodology:
      'Scout resolved the bounded Texas place prompt, fetched the requested place evidence, and returned the place context without inventing any data.',
    keyFindings: [
      `${result.value.label} is grounded in ${result.value.scope}.`,
      coordinates ? `Coordinates: ${coordinates}.` : 'Coordinates were not available from the grounded place record.',
    ],
    evidence: [
      `Place: ${result.value.label}.`,
      coordinates ? `Coordinates: ${coordinates}.` : 'The place adapter returned a grounded place record.',
      result.value.periodLabel ? `Period: ${result.value.periodLabel}.` : 'The place adapter returned a bounded cited value.',
      result.value.note ? `Note: ${result.value.note}.` : 'The place adapter returned a bounded cited value.',
    ],
    caveats: ['Only Texas ZIP, county, and metro place prompts are supported in this bounded lane.'],
    nextQuestions: ['Ask for another Texas ZIP, county, or metro if you want the same place context elsewhere.'],
    citations: result.citations,
  }
}

function buildDriveTimeTrace(result: AgentDriveTimeEvidenceResult): AgentTrace {
  const distance =
    Number.isFinite(result.value.distanceMiles) ? `${result.value.distanceMiles!.toFixed(1)} miles (road-factor estimate)` : null

  return {
    summary: `Drive-time grounding for ${result.value.scope}`,
    taskType: 'explain_metric',
    methodology:
      'Scout resolved the bounded Texas route request, grounded both endpoints through the place adapter, and derived a bounded drive-time estimate without inventing uncited route data.',
    keyFindings: [
      `${result.value.label} for ${result.value.scope}: ${result.value.displayValue}.`,
      distance ? `Estimated route distance: ${distance}.` : 'The route adapter returned a bounded cited estimate.',
    ],
    evidence: [
      `Route: ${result.value.scope}.`,
      `Estimated drive time: ${result.value.displayValue}.`,
      distance ? `Estimated route distance: ${distance}.` : 'The route adapter returned a bounded cited estimate.',
      result.value.periodLabel ? `Period: ${result.value.periodLabel}.` : 'The route adapter returned a bounded cited value.',
      result.value.note ? `Note: ${result.value.note}.` : 'The route adapter returned a bounded cited value.',
    ],
    caveats: ['Drive-time responses use Google Maps computeRoutes when available and otherwise fall back to a bounded Texas estimate; they are not turn-by-turn directions.'],
    nextQuestions: ['Ask for another Texas ZIP, county, or metro pair if you want the same route context elsewhere.'],
    citations: result.citations,
  }
}

async function maybeBuildDriveTimeGroundingResponse(
  userMessage: string,
  context: MapContext | null,
  dependencies: HistoryComparisonDependencies
): Promise<AgentPipelineResult | null> {
  if (!looksLikeDriveTimePlacePrompt(userMessage)) return null

  if (hasActiveComparisonMarker(userMessage) && !resolveActiveComparisonSubject(context)) {
    return buildMissingActiveDriveTimePayload()
  }

  const markets = resolveDriveTimeMarkets(userMessage, context)
  if (!markets) {
    return buildUnresolvedDriveTimePayload()
  }

  const fetchDriveTimeGrounding =
    dependencies.getDriveTimeGrounding ??
    (async (query: AgentDriveTimeQuery) => retrieveDriveTimeGrounding(query))

  try {
    const evidence = await fetchDriveTimeGrounding({
      prompt: userMessage,
      origin: markets[0],
      destination: markets[1],
    })

    return await finalizeAgentPipelineResult({
      message: `Estimated drive time from ${markets[0].label} to ${markets[1].label}: ${evidence.value.displayValue}.`,
      action: { type: 'none' as const },
      trace: buildDriveTimeTrace(evidence),
      chart: null,
    })
  } catch {
    return buildDriveTimeFailurePayload(markets)
  }
}

async function maybeBuildPlaceGroundingResponse(
  userMessage: string,
  context: MapContext | null,
  dependencies: HistoryComparisonDependencies
): Promise<AgentPipelineResult | null> {
  if (!hasPlaceIntent(userMessage)) return null

  const subject = resolvePlaceGroundingSubject(userMessage, context)
  if (!subject) {
    return buildUnresolvedPlacePayload()
  }

  const fetchPlaceGrounding =
    dependencies.getPlaceGrounding ??
    (async (query: AgentPlaceGroundingQuery) => {
      const { retrievePlaceGrounding } = await import('@/lib/agent-place-grounding')
      return retrievePlaceGrounding(query)
    })

  try {
    const evidence = await fetchPlaceGrounding({
      prompt: userMessage,
      subject,
      requestType: 'place',
    })
    const lat = evidence.value.lat
    const lng = evidence.value.lng
    if (typeof lat !== 'number' || !Number.isFinite(lat) || typeof lng !== 'number' || !Number.isFinite(lng)) {
      return buildPlaceFailurePayload(subject)
    }

    return await finalizeAgentPipelineResult({
      message: `Here are the coordinates for ${evidence.value.scope}: ${lat.toFixed(4)}, ${lng.toFixed(4)}.`,
      action: { type: 'none' as const },
      trace: buildPlaceTrace(evidence),
      chart: null,
    })
  } catch {
    return buildPlaceFailurePayload(subject)
  }
}

async function maybeBuildPublicMacroResponse(
  userMessage: string,
  context: MapContext | null,
  dependencies: HistoryComparisonDependencies
): Promise<AgentPipelineResult | null> {
  if (!hasPublicMacroIntent(userMessage)) return null

  const metric = detectPublicMacroMetric(userMessage)
  const subject = resolveHistorySubjectMarket(userMessage, context)
  if (!subject) return buildUnresolvedPublicMacroPayload()
  if (!metric) return buildUnsupportedPublicMacroPayload(subject)

  const fetchPublicMacroEvidence =
    dependencies.getPublicMacroEvidence ??
    (async (query: AgentPublicMacroQuery) => retrievePublicMacroEvidence(query))

  try {
    const evidence = await fetchPublicMacroEvidence({
      metric,
      subject,
    })
    const trace = buildPublicMacroTrace(evidence)
    return await finalizeAgentPipelineResult({
      message: `Here is the ${evidence.value.label.toLowerCase()} for ${evidence.value.scope}: ${evidence.value.displayValue}.`,
      action: { type: 'none' as const },
      trace,
      chart: null,
    })
  } catch {
    return buildPublicMacroFailurePayload(subject)
  }
}

async function maybeBuildHistoryChartedResponse(
  userMessage: string,
  context: MapContext | null,
  dependencies: HistoryComparisonDependencies = {}
): Promise<AgentPipelineResult | null> {
  const consumerMarket = await maybeBuildConsumerMarketComparisonResponse(userMessage, dependencies)
  if (consumerMarket) return consumerMarket

  const coreRetail = await maybeBuildCoreRetailComparisonResponse(userMessage, dependencies)
  if (coreRetail) return coreRetail

  const wantsPeerComparison = hasPeerComparisonIntent(userMessage)
  const wantsHistory = hasHistoryIntent(userMessage)
  if (!wantsHistory && !wantsPeerComparison) {
    const driveTime = await maybeBuildDriveTimeGroundingResponse(userMessage, context, dependencies)
    if (driveTime) return driveTime

    const place = await maybeBuildPlaceGroundingResponse(userMessage, context, dependencies)
    if (place) return place

    const publicMacro = await maybeBuildPublicMacroResponse(userMessage, context, dependencies)
    if (publicMacro) return publicMacro
  }

  const explicitPeerMarkets = wantsPeerComparison ? resolvePeerComparisonMarkets(userMessage) : null
  const activeVsExplicitMarkets =
    wantsPeerComparison && !explicitPeerMarkets ? resolveActiveVsExplicitComparisonMarkets(userMessage, context) : null
  const peerMarkets = explicitPeerMarkets ?? activeVsExplicitMarkets
  const isAnalyticalHistoryRequest = wantsHistory || wantsPeerComparison
  if (!isAnalyticalHistoryRequest) return null

  if (wantsPeerComparison && !peerMarkets) {
    if (hasActiveComparisonMarker(userMessage) && !resolveActiveComparisonSubject(context)) {
      return buildMissingActiveComparisonMarketPayload()
    }
    return buildUnresolvedPeerComparisonPayload()
  }

  const metric = detectHistoryMetric(userMessage)
  if (!metric) {
    return peerMarkets
      ? buildUnsupportedComparisonMetricPayload(peerMarkets)
      : buildUnsupportedHistoryPayload(
          'That history metric is not supported yet. Scout only handles rent, unemployment rate, and permit units for now.'
        )
  }

  const austinMonthlyResponse = await maybeBuildAustinMonthlyPermitHistoryResponse(
    userMessage,
    metric,
    peerMarkets?.[1] ?? null,
    dependencies
  )
  if (austinMonthlyResponse) return austinMonthlyResponse

  const subjectMarket = peerMarkets?.[0] ?? resolveHistorySubjectMarket(userMessage, context)
  const comparisonMarket = peerMarkets?.[1] ?? null
  const timeWindow = resolveExplicitHistoryWindow(userMessage, metric)
  if (!subjectMarket) {
    return {
      message: 'I could not identify which ZIP, county, or metro to use for that history request.',
      action: { type: 'none' as const },
      trace: {
        summary: 'History request missing a resolvable geography',
        taskType: 'explain_metric',
        methodology:
          'Scout found a supported history metric, but no grounded subject geography could be resolved from the prompt or current workspace.',
        keyFindings: ['No chart was generated.'],
        evidence: ['The route needs a ZIP, county, or metro to send the request to the history router.'],
        caveats: ['Try naming the geography directly or load the market first.'],
        nextQuestions: ['Ask for rent history on a ZIP like 78701.', 'Ask for permit history for a Texas county like Harris County, TX.'],
      },
      chart: null,
    }
  }

  if (metric === 'rent' && subjectMarket.kind !== 'zip') {
    return {
      message: 'Rent history is only supported for ZIP subjects right now. Try a ZIP like 78701.',
      action: { type: 'none' as const },
      trace: {
        summary: 'Rent history requires a ZIP subject',
        taskType: 'explain_metric',
        methodology:
          'Scout recognized a rent-history prompt but the bounded router path only supports rent at ZIP granularity.',
        keyFindings: ['No chart was generated.'],
        evidence: [`Resolved subject kind: ${subjectMarket.kind}.`],
        caveats: ['Rent history needs a ZIP subject in the current router contract.'],
        nextQuestions: ['Ask for rent history on a ZIP code.', 'Ask for permit or unemployment history on a county or metro.'],
      },
      chart: null,
    }
  }

  if (comparisonMarket && subjectMarket.kind !== comparisonMarket.kind) {
    return {
      message: 'Both comparison markets need to resolve to the same geography type for this bounded comparison path.',
      action: { type: 'none' as const },
      trace: {
        summary: 'Peer comparison requires matching geography kinds',
        taskType: 'compare_segments',
        methodology:
          'Scout recognized a comparison request, but the two resolved geographies did not map to the same subject kind.',
        keyFindings: ['No chart was generated.'],
        evidence: [`Resolved kinds: ${subjectMarket.kind} and ${comparisonMarket.kind}.`],
        caveats: ['Use ZIP vs ZIP, county vs county, or metro vs metro comparisons.'],
        nextQuestions: ['Ask for a ZIP-to-ZIP comparison.', 'Ask for a county-to-county comparison within Texas.'],
      },
      chart: null,
    }
  }

  if (metric === 'rent' && comparisonMarket && comparisonMarket.kind !== 'zip') {
    return {
      message: 'Rent comparisons are only supported for ZIP subjects right now.',
      action: { type: 'none' as const },
      trace: {
        summary: 'Rent comparison requires ZIP subjects',
        taskType: 'compare_segments',
        methodology:
          'Scout recognized a rent comparison request but the bounded router path only supports rent at ZIP granularity.',
        keyFindings: ['No chart was generated.'],
        evidence: [`Resolved subject kinds: ${subjectMarket.kind}${comparisonMarket ? ` and ${comparisonMarket.kind}` : ''}.`],
        caveats: ['Use two ZIP codes for rent comparisons.'],
        nextQuestions: ['Ask to compare rent history between two ZIPs like 78701 and 77002.'],
      },
      chart: null,
    }
  }

  const fetchAnalyticalComparison =
    dependencies.getAnalyticalComparison ?? (async (request: AnalyticalComparisonRequest) => {
      const { getAnalyticalComparison } = await import('@/lib/data/market-data-router')
      return getAnalyticalComparison(request)
    })

  const runHistoryComparison = async (currentSubjectMarket: AgentHistorySubject) => {
    const comparison = await fetchAnalyticalComparison(
      comparisonMarket
        ? {
            comparisonMode: 'peer_market',
            metric,
            subjectMarket: currentSubjectMarket,
            comparisonMarket,
            timeWindow,
          }
        : buildHistoryComparisonRequest(metric, currentSubjectMarket, timeWindow)
    )
    const provenance = await getInternalEvidenceForHistoryComparison(comparison, dependencies, currentSubjectMarket)
    const baseCitations =
      provenance.citations.length > 0 ? comparison.citations.filter(hasCompleteScoutChartCitation) : comparison.citations
    const enrichedCitations = mergeScoutChartCitationSets(baseCitations, provenance.citations)
    const enrichedComparison: AnalyticalComparisonResult = {
      ...comparison,
      citations: toAnalyticalComparisonCitations(enrichedCitations),
    }
    const chart = buildHistoryChartFromComparison(enrichedComparison)
    const subjectLine =
      enrichedComparison.comparisonMode === 'peer_market' && enrichedComparison.series.length >= 2
        ? `${enrichedComparison.series[0]?.label ?? currentSubjectMarket.label} versus ${enrichedComparison.series[1]?.label ?? comparisonMarket?.label ?? 'the comparison market'}`
        : enrichedComparison.series[0]?.label ?? currentSubjectMarket.label
    const trace = buildHistoryTrace(enrichedComparison)
    const provenanceEvidence =
      provenance.records.length > 0
        ? [`Internal provenance matched: ${provenance.records.map((record) => record.label).join(', ')}.`]
        : []

    return finalizeAgentPipelineResult({
      message:
        enrichedComparison.comparisonMode === 'peer_market'
          ? `Here is the ${enrichedComparison.timeWindow.label.toLowerCase()} ${enrichedComparison.metricLabel.toLowerCase()} comparison for ${subjectLine}.`
          : `Here is the ${enrichedComparison.timeWindow.label.toLowerCase()} ${enrichedComparison.metricLabel.toLowerCase()} history for ${subjectLine}.`,
      action: { type: 'none' as const },
      trace: {
        ...trace,
        evidence: [...(trace.evidence ?? []), ...provenanceEvidence],
      },
      chart,
    }, dependencies)
  }

  const countyProxySubject =
    !comparisonMarket && metric !== 'rent' ? resolveTexasCityHistoryCountyProxy(userMessage) : null

  try {
    return await runHistoryComparison(subjectMarket)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to build a grounded history response.'

    if (
      /insufficient historical data/i.test(message) &&
      countyProxySubject &&
      countyProxySubject.id !== subjectMarket.id
    ) {
      try {
        return await runHistoryComparison(countyProxySubject)
      } catch (proxyError) {
        const proxyMessage =
          proxyError instanceof Error ? proxyError.message : 'Unable to build a grounded history response.'
        if (/insufficient historical data/i.test(proxyMessage)) {
          return {
            message: proxyMessage,
            action: { type: 'none' as const },
            trace: {
              summary: 'Insufficient historical data',
              taskType: 'spot_trends',
              methodology:
                'Scout delegated the request to the router, retried the city through a bounded county proxy, and still did not receive enough historical points to chart.',
              keyFindings: ['No chart was generated.'],
              evidence: [proxyMessage],
              caveats: ['Try a broader time window or a subject with more persisted history.'],
              nextQuestions: ['Ask for a longer history window.', 'Try a ZIP, county, or metro with more persisted rows.'],
            },
            chart: null,
          }
        }
      }
    }

    if (/unsupported analytical metric/i.test(message)) {
      return buildUnsupportedHistoryPayload(
        'That history metric is not supported yet. Scout only handles rent, unemployment rate, and permit units for now.'
      )
    }

    if (/insufficient historical data/i.test(message)) {
      return {
        message,
        action: { type: 'none' as const },
        trace: {
          summary: 'Insufficient historical data',
          taskType: 'spot_trends',
          methodology:
            'Scout delegated the request to the router, but the router did not return enough historical points to chart.',
          keyFindings: ['No chart was generated.'],
          evidence: [message],
          caveats: ['Try a broader time window or a subject with more persisted history.'],
          nextQuestions: ['Ask for a longer history window.', 'Try a ZIP, county, or metro with more persisted rows.'],
        },
        chart: null,
      }
    }

    return {
      message: 'I could not complete that history request from the current grounded data.',
      action: { type: 'none' as const },
      trace: {
        summary: 'History request could not be completed',
        taskType: 'spot_trends',
        methodology:
          'Scout normalized the history request, but the router call failed before a grounded series could be returned.',
        keyFindings: ['No chart was generated.'],
        evidence: [message],
        caveats: ['Try again with a clearer geography or a supported metric.'],
        nextQuestions: ['Ask for rent, unemployment rate, or permit history on the active market.'],
      },
      chart: null,
    }
  }
}

function maybeBuildFallbackChart(userMessage: string, context: MapContext | null): ScoutChartOutput | null {
  const prompt = userMessage.toLowerCase()
  const wantsTrend = /\b(trend|over time|history|timeline)\b/.test(prompt)
  if (!wantsTrend) return null

  const label = context?.label ?? context?.eda?.geographyLabel ?? 'Current market'

  return normalizeScoutChartOutput({
    kind: 'line',
    title: `${label} rent trend`,
    subtitle: 'Phase 1 chart contract demo',
    summary: 'Temporary chart payload used to validate the shared analytical rendering path.',
    placeholder: true,
    confidenceLabel: 'placeholder data',
    xAxis: { key: 'period', label: 'Period' },
    yAxis: { label: 'Indexed rent', valueFormat: 'index' },
    series: [
      {
        key: 'rent_index',
        label: 'Rent index',
        color: '#D76B3D',
        points: [
          { x: 'Start', y: 100 },
          { x: 'Mid', y: 104 },
          { x: 'Latest', y: 108 },
        ],
      },
    ],
    citations: [
      {
        id: 'phase1-placeholder-series',
        label: 'Phase 1 placeholder series',
        sourceType: 'placeholder',
        note: 'Replace with router-backed historical series during later convergence tasks.',
        placeholder: true,
      },
    ],
  })
}

function attachTraceCitations(trace: AgentTrace, chart: ScoutChartOutput | null): AgentTrace {
  if (!chart || chart.citations.length === 0) return trace

  return {
    ...trace,
    citations: chart.citations,
  }
}

export function buildFallbackChartedResponseForTest(userMessage: string, context: MapContext | null) {
  const fallback = buildFallbackEdaResponse(userMessage, context)
  const chart = maybeBuildFallbackChart(userMessage, context)

  return {
    message: fallback.message,
    trace: attachTraceCitations(fallback.trace, chart),
    chart,
  }
}

export async function buildHistoryChartedResponseForTest(
  userMessage: string,
  context: MapContext | null,
  dependencies: HistoryComparisonDependencies = {}
) {
  return maybeBuildHistoryChartedResponse(userMessage, context, dependencies)
}

export async function buildRetailComparisonResponseForTest(
  userMessage: string,
  dependencies: HistoryComparisonDependencies = {}
) {
  return maybeBuildCoreRetailComparisonResponse(userMessage, dependencies)
}

export function buildConsumerMarketResponseForTest(
  userMessage: string,
  dependencies: HistoryComparisonDependencies = {}
) {
  return maybeBuildConsumerMarketComparisonResponse(userMessage, dependencies)
}

function buildDefaultMapControlMessage(action: AgentAction): string {
  if (action.type === 'search') return `Navigating to ${action.query}.`
  if (action.type === 'toggle_layers') {
    const layerKeys = Object.keys(action.layers ?? {})
    const allOff = layerKeys.every((key) => action.layers?.[key] === false)
    const humanLayerNames = layerKeys.map((key) => humanizeLayerKey(key)).join(', ')
    return `${allOff ? 'Turning off' : 'Turning on'} ${humanLayerNames}.`
  }
  if (action.type === 'set_tilt') return action.tilt === 0 ? 'Flattening the map to 2D.' : `Setting map tilt to ${action.tilt}°.`
  if (action.type === 'focus_data_panel') return 'Opening the data panel.'
  if (action.type === 'generate_memo') return 'Opening the analysis panel.'
  return 'Updating the map.'
}

function normalizeMapControlAction(
  parsed: MapControlActionJson,
  context: MapContext | null | undefined
): NormalizedMapControlStep | null {
  const actionType = typeof parsed.actionType === 'string' ? parsed.actionType : 'none'
  const explicitMessage = typeof parsed.message === 'string' ? parsed.message.trim() : ''

  if (actionType === 'search') {
    const query = typeof parsed.searchQuery === 'string'
      ? normalizeMapSearchQuery(parsed.searchQuery.trim().replace(/[.,;:!?]+$/g, ''))
      : ''
    if (!query || looksAnalyticalPrompt(query)) return null

    const activeLabel = context?.label?.trim().toLowerCase() ?? ''
    if (activeLabel && activeLabel === query.toLowerCase()) {
      return {
        message: explicitMessage || `${query} is already the active market.`,
        action: { type: 'none' },
        summary: 'Active market already loaded',
      }
    }

    return {
      message: explicitMessage || `Navigating to ${query}.`,
      action: { type: 'search', query },
      summary: `Navigate to ${query}`,
    }
  }

  if (actionType === 'toggle_layers') {
    const layers = normalizeLayerRecord(parsed.layers)
    const layerKeys = Object.keys(layers)
    if (layerKeys.length === 0) return null

    const action: AgentAction = { type: 'toggle_layers', layers }
    const humanLayerNames = layerKeys.map((key) => humanizeLayerKey(key)).join(', ')
    const allOff = layerKeys.every((key) => layers[key] === false)
    return {
      message: explicitMessage || buildDefaultMapControlMessage(action),
      action,
      summary: `${allOff ? 'Hide' : 'Show'} ${humanLayerNames}`,
    }
  }

  if (actionType === 'set_tilt') {
    const tilt = typeof parsed.tilt === 'number' && Number.isFinite(parsed.tilt)
      ? Math.max(0, Math.min(60, Math.round(parsed.tilt)))
      : null
    if (tilt == null) return null

    const action: AgentAction = { type: 'set_tilt', tilt }
    return {
      message: explicitMessage || buildDefaultMapControlMessage(action),
      action,
      summary: tilt === 0 ? 'Switch to 2D view' : 'Set map tilt',
    }
  }

  if (actionType === 'focus_data_panel') {
    const action: AgentAction = { type: 'focus_data_panel' }
    return {
      message: explicitMessage || buildDefaultMapControlMessage(action),
      action,
      summary: 'Open data panel',
    }
  }

  if (actionType === 'generate_memo') {
    const action: AgentAction = { type: 'generate_memo' }
    return {
      message: explicitMessage || buildDefaultMapControlMessage(action),
      action,
      summary: 'Open analysis panel',
    }
  }

  return null
}

function normalizeMapControlSteps(
  value: unknown,
  context: MapContext | null | undefined
): NormalizedMapControlStep[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((step) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return []
    const normalized = normalizeMapControlAction(step as MapControlActionJson, context)
    return normalized ? [normalized] : []
  })
}

function buildGeminiMapControlTrace(
  summary: string,
  reason: string | null,
  confidence: number | null,
  steps: NormalizedMapControlStep[]
): AgentTrace {
  const normalizedReason = reason?.replace(/[.?!\s]+$/g, '') ?? null

  return {
    summary,
    methodology:
      'Scout used a bounded Gemini parser to interpret the natural-language map-control request into explicit UI actions, then normalized the result into canonical search, layer, and view commands.',
    keyFindings: [
      summary,
      steps.length > 1 ? `${steps.length} ordered map actions were extracted from one prompt.` : 'A direct map action was extracted from the prompt.',
    ],
    evidence: [
      confidence != null ? `Parser confidence: ${confidence.toFixed(2)}.` : 'The parser returned a structured action plan.',
      normalizedReason ? `Parser reason: ${normalizedReason}.` : 'The parser used the natural-language request plus current map state to derive the action plan.',
    ],
    caveats: ['Slash-prefixed terminal commands still stay on the local deterministic path; this NLP parser is only for natural-language agent prompts.'],
    nextQuestions: ['After the action runs, ask for EDA on the active market or imported dataset if you want interpretation.'],
    executionSteps: steps.map((step) => ({
      message: step.message,
      actionType: step.action.type,
    })),
  }
}

function buildAgentSteps(steps: NormalizedMapControlStep[]): AgentStep[] {
  return steps.map((step, index) => ({
    delay: index * 900,
    message: step.message,
    action: step.action,
  }))
}

function normalizeMapControlPlan(
  parsed: MapControlPlanJson,
  context: MapContext | null | undefined
): AgentPipelineResult | null {
  const confidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence) ? parsed.confidence : null
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : null
  if (confidence != null && confidence < 0.6) return null

  const explicitMessage = typeof parsed.message === 'string' ? parsed.message.trim() : ''
  const normalizedSteps = normalizeMapControlSteps(parsed.steps, context)

  if (normalizedSteps.length > 0) {
    const summary = normalizedSteps.length > 1
      ? `Execute ${normalizedSteps.length}-step map-control sequence`
      : normalizedSteps[0]?.summary ?? 'Execute map-control action'

    return {
      message: explicitMessage || normalizedSteps.map((step) => step.message).join(' '),
      steps: buildAgentSteps(normalizedSteps),
      trace: buildGeminiMapControlTrace(summary, reason, confidence, normalizedSteps),
    }
  }

  const singleAction = normalizeMapControlAction(parsed, context)
  if (!singleAction) return null

  return {
    message: explicitMessage || singleAction.message,
    action: singleAction.action,
    trace: buildGeminiMapControlTrace(singleAction.summary, reason, confidence, [singleAction]),
  }
}

function getPrimarySearchTarget(plan: AgentPipelineResult): string | null {
  if (plan.action?.type === 'search') return plan.action.query ?? null
  return plan.steps?.find((step) => step.action.type === 'search')?.action.query ?? null
}

function normalizeDeterministicMapControl(
  deterministic: ReturnType<typeof inferDirectMapControl>
): AgentPipelineResult | null {
  if (!deterministic) return null
  return {
    message: deterministic.message,
    action: deterministic.action,
    trace: deterministic.trace,
  }
}

async function inferMapControlWithModel(
  prompt: string,
  context: MapContext | null | undefined
): Promise<AgentPipelineResult | null> {
  const deterministic = inferDirectMapControl(prompt, context)
  if (!process.env.GEMINI_API_KEY) return normalizeDeterministicMapControl(deterministic)

  try {
    const model = getGeminiJsonModel(MAP_CONTROL_SYSTEM_PROMPT)
    const result = await model.generateContent(
      [
        `USER REQUEST: ${prompt}`,
        `ACTIVE MARKET LABEL: ${context?.label ?? 'none'}`,
        `ACTIVE LAYERS: ${
          Object.entries(context?.layers ?? {})
            .filter(([, enabled]) => enabled)
            .map(([key]) => key)
            .join(', ') || 'none'
        }`,
      ].join('\n')
    )

    const parsed = normalizeMapControlPlan(parseMapControlPlanJson(result.response.text().trim()), context)
    return parsed ?? normalizeDeterministicMapControl(deterministic)
  } catch {
    return normalizeDeterministicMapControl(deterministic)
  }
}

function unresolvedMapControlPayload() {
  return {
    message:
      'I could not confidently parse that map-control request. Try a direct prompt like "take me to Harris County, TX" or "turn on transit," then ask the follow-up analysis.',
    action: { type: 'none' as const },
    trace: {
      summary: 'Map-control request could not be parsed',
      methodology:
        'Scout checked the bounded Gemini map-control parser and the deterministic backup parser, but neither produced a confident control action.',
      keyFindings: ['No map-control action was executed.'],
      evidence: ['The request was classified as direct map control, but no confident structured action could be extracted.'],
      caveats: ['Retry with a slightly more direct command if you want navigation or a UI control change first.'],
      nextQuestions: ['Try "take me to Harris County, TX."', 'Try "turn on transit."', 'After the action runs, ask the analysis question again.'],
    },
  }
}

async function runAgentPipeline(context: MapContext | null, userMessage: string): Promise<AgentPipelineResult> {
  const intent = classifyAgentRequestIntent(userMessage, context)
  if (intent.lane === 'direct_map_control') {
    const mapControl = await inferMapControlWithModel(userMessage, context)
    if (mapControl) {
      if (looksAnalyticalPrompt(userMessage)) {
        const fallback = buildFallbackEdaResponse(userMessage, context)
        const target = getPrimarySearchTarget(mapControl)

        if (target) {
          return {
            message: `Navigating to ${target}. Once that market loads, ask again and I’ll explain the requested snapshot using the active market data.`,
            action: mapControl.action,
            steps: mapControl.steps,
            trace: buildHybridMapAnalysisTrace(
              `Navigate to ${target} for follow-up analysis`,
              [
                `Matched an explicit navigation request for ${target}.`,
                mapControl.steps?.length
                  ? 'The direct prompt also included additional map actions, which will run after the navigation step.'
                  : 'The analytical part of the prompt refers to a market that is not yet the active workspace.',
              ],
              [
                `I did not answer the analysis part yet because that would have used the current workspace instead of ${target}.`,
              ],
              [`After ${target} loads, ask the same question again to get the market explanation.`]
            ),
          }
        }

        return {
          message: `${mapControl.message} ${fallback.message}`.trim(),
          action: mapControl.action,
          steps: mapControl.steps,
          trace: mergeTrace(
            {
              summary: `${mapControl.trace.summary} + ${fallback.trace.summary}`,
              methodology: 'Executed the explicit map-control request first, then answered the analytical part against the current workspace.',
              keyFindings: [
                ...(mapControl.trace.keyFindings ?? []),
                ...(fallback.trace.keyFindings ?? []),
              ].slice(0, 4),
              evidence: [
                ...(mapControl.trace.evidence ?? []),
                ...(fallback.trace.evidence ?? []),
              ].slice(0, 6),
              caveats: [
                ...(mapControl.trace.caveats ?? []),
                ...(fallback.trace.caveats ?? []),
              ].slice(0, 4),
              nextQuestions: fallback.trace.nextQuestions ?? mapControl.trace.nextQuestions,
            },
            fallback.trace
          ),
        }
      }

      return {
        message: mapControl.message,
        action: mapControl.action,
        steps: mapControl.steps,
        trace: mapControl.trace,
      }
    }

    return unresolvedMapControlPayload()
  }

  const history = await maybeBuildHistoryChartedResponse(userMessage, context)
  if (history) {
    return history
  }

  const fallback = buildFallbackEdaResponse(userMessage, context)
  const taskType = inferEdaTaskType(userMessage, context)

  if (!process.env.GEMINI_API_KEY) {
    const chart =
      (await buildRentTrendChart(userMessage, context)) ??
      (await buildRouterBackedChart(userMessage, context)) ??
      maybeBuildFallbackChart(userMessage, context)
    return finalizeAgentPipelineResult({
      message: fallback.message,
      action: { type: 'none' as const },
      trace: attachTraceCitations(fallback.trace, chart),
      chart,
    })
  }

  const model = getGeminiJsonModel(SYSTEM_PROMPT)

  try {
    const contextStr = buildEdaContextString(userMessage, context)
    const chart =
      (await buildRentTrendChart(userMessage, context)) ??
      (await buildRouterBackedChart(userMessage, context)) ??
      maybeBuildFallbackChart(userMessage, context)
    const result = await model.generateContent(
      `${contextStr}\n\nDETERMINISTIC FALLBACK TRACE (use as the minimum evidence floor; you may rephrase but not contradict it):\n${JSON.stringify(
        {
          message: fallback.message,
          trace: fallback.trace,
        },
        null,
        2
      )}\n\nUSER REQUEST:\n${userMessage}`
    )

    const parsed = parseGeminiAgentJson(result.response.text().trim())
    const normalized = normalizeAgentTrace(
      {
        ...(parsed.trace && typeof parsed.trace === 'object' ? parsed.trace : {}),
        taskType,
      },
      null,
      null
    )

    return finalizeAgentPipelineResult({
      message: parsed.message?.trim() || fallback.message,
      action: { type: 'none' as const },
      trace: attachTraceCitations(mergeTrace(normalized, fallback.trace), chart),
      chart,
    })
  } catch {
    const chart =
      (await buildRentTrendChart(userMessage, context)) ??
      (await buildRouterBackedChart(userMessage, context)) ??
      maybeBuildFallbackChart(userMessage, context)
    return finalizeAgentPipelineResult({
      message: fallback.message,
      action: { type: 'none' as const },
      trace: attachTraceCitations(fallback.trace, chart),
      chart,
    })
  }
}

function blockedAgentTrace(reason: string): AgentTrace {
  return {
    summary: 'Prompt blocked before EDA analysis',
    taskType: 'summarize_dataset',
    methodology: 'The request policy rejected this prompt before any model call or deterministic EDA work ran.',
    keyFindings: ['This prompt falls outside the bounded Scout EDA assistant scope.'],
    evidence: ['The assistant now only handles dataset- and market-grounded exploratory analysis.'],
    caveats: [`Policy reason: ${reason}.`],
    nextQuestions: ['Ask about the loaded market, an imported dataset, outliers, distributions, trends, or data quality.'],
  }
}

function blockedAgentPayload(policy: Exclude<ReturnType<typeof evaluateAgentRequestPolicy>, { allowed: true }>) {
  return {
    message: policy.message,
    action: { type: 'none' as const },
    trace: blockedAgentTrace(policy.reason),
  }
}

function blockedAgentStreamResponse(payload: ReturnType<typeof blockedAgentPayload>) {
  const encoder = new TextEncoder()
  const line = `${JSON.stringify({ type: 'done', ...payload })}\n`
  return new Response(encoder.encode(line), {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function classifyAgentError(err: unknown): { message: string; status: number } {
  const message = err instanceof Error ? err.message : 'Unexpected error'
  const normalized = message.toLowerCase()

  if (normalized.includes('429') || normalized.includes('too many requests') || normalized.includes('resource exhausted')) {
    return {
      message: 'Gemini rate limit reached for this request. Retry in a moment.',
      status: 429,
    }
  }

  if (normalized.includes('503 service unavailable')) {
    return {
      message: 'Gemini is temporarily unavailable due to upstream load. Retry in a moment.',
      status: 503,
    }
  }

  return {
    message,
    status: 500,
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      message?: string
      context?: MapContext | null
      stream?: boolean
    }

    const userMessage = typeof body.message === 'string' ? body.message : ''
    const context = body.context ?? null
    const stream = body.stream === true

    const policy = evaluateAgentRequestPolicy(userMessage, context)
    if (!policy.allowed) {
      const payload = blockedAgentPayload(policy)
      if (stream) return blockedAgentStreamResponse(payload)
      return NextResponse.json(payload)
    }

    if (stream) {
      const encoder = new TextEncoder()
      const readable = new ReadableStream<Uint8Array>({
        async start(controller) {
          const push = (obj: Record<string, unknown>) => {
            controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`))
          }

          try {
            push({ type: 'status', phase: 'json' })
            const out = await runAgentPipeline(context, userMessage)
            push({
              type: 'done',
              message: out.message,
              action: out.action,
              steps: out.steps,
              trace: out.trace,
              chart: out.chart,
              companionOutputs: out.companionOutputs,
            })
          } catch (err) {
            const failure = classifyAgentError(err)
            push({
              type: 'error',
              error: failure.message,
              status: failure.status,
              retryable: failure.status === 429 || failure.status === 503,
            })
          } finally {
            controller.close()
          }
        },
      })

      return new Response(readable, {
        status: 200,
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    }

    const out = await runAgentPipeline(context, userMessage)
    return NextResponse.json(out)
  } catch (err) {
    const failure = classifyAgentError(err)
    return NextResponse.json({ error: failure.message }, { status: failure.status })
  }
}
