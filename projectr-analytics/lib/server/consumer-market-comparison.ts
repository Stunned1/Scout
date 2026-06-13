import { GoogleGenerativeAI } from '@google/generative-ai'

import type { AgentCompanionOutput, AgentTrace, AgentTraceToolRow } from '@/lib/agent-types'
import { geocodeAddressForward } from '@/lib/google-forward-geocode'
import { fetchOverturePlaces } from '@/lib/overture-client'
import { OVERTURE_SIGNAL_CATEGORY_NAMES } from '@/lib/overture-core-retail-taxonomy'
import { normalizeScoutChartOutput, type ScoutChartCitation, type ScoutChartOutput } from '@/lib/scout-chart-output'

/**
 * Agentic consumer-market comparison: "compare the consumer market for a <business> in <city> vs <city>".
 *
 * Unlike the bounded pre-grounded paths, this path runs a real plan -> fetch -> synthesize loop:
 *   1. Gemini extracts the business type and cities, and picks relevant Overture POI categories.
 *   2. Live tools fetch the evidence: Census ACS API (work-from-home share, median household
 *      income, population), Google forward geocoding (city cores), Overture POIs (supply density).
 *   3. Gemini writes the analyst takeaways from the fetched values only.
 * Every chart cites the live source it was built from; nothing is pinned.
 */

const POI_RADIUS_METERS = 1200
const POI_FETCH_LIMIT = 250
const ACS_VINTAGE = 2024
const ACS_PERIOD_LABEL = `ACS ${ACS_VINTAGE} 1-year estimates`

const CONSUMER_MARKET_PROMPT_PATTERN = /\b(consumer market|customer market|market for)\b/i
const COMPARISON_PATTERN = /\b(compare|comparison|versus|vs\.?|between|against)\b/i

const STATE_ABBR_TO_FIPS: Record<string, string> = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', DC: '11',
  FL: '12', GA: '13', HI: '15', ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21',
  LA: '22', ME: '23', MD: '24', MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30',
  NE: '31', NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38', OH: '39',
  OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46', TN: '47', TX: '48', UT: '49',
  VT: '50', VA: '51', WA: '53', WV: '54', WI: '55', WY: '56',
}

export interface ConsumerMarketPlanCity {
  name: string
  stateAbbr: string
}

export interface ConsumerMarketPlan {
  businessType: string
  businessLabel: string
  overtureCategories: string[]
  cityA: ConsumerMarketPlanCity
  cityB: ConsumerMarketPlanCity
  confidence: number
}

export interface ConsumerMarketCityEvidence {
  name: string
  stateAbbr: string
  geoId: string
  censusName: string
  workFromHomePct: number | null
  medianHouseholdIncome: number | null
  population: number | null
  poiCount: number | null
  /** Geocoded city-core anchor the POI snapshot was taken around. */
  corePoint: { lat: number; lng: number } | null
}

export interface ConsumerMarketSynthesis {
  message: string
  keyFindings: string[]
  caveats: string[]
}

export interface ConsumerMarketComparisonOutcome {
  message: string
  trace: AgentTrace
  chart: ScoutChartOutput
  companionOutputs: AgentCompanionOutput[]
}

export interface ConsumerMarketDependencies {
  /** JSON-mode model call; defaults to Gemini. Returns the raw model text. */
  generateJson?: (systemInstruction: string, prompt: string) => Promise<string>
  /** Fetches a Census API URL and returns the row matrix. */
  fetchCensusRows?: (url: string) => Promise<string[][]>
  geocodeCity?: (query: string) => Promise<{ lat: number; lng: number } | null>
  fetchPois?: (lat: number, lng: number, radius: number, categories: string, limit: number) => Promise<unknown[]>
}

export function hasConsumerMarketComparisonIntent(userMessage: string): boolean {
  return CONSUMER_MARKET_PROMPT_PATTERN.test(userMessage) && COMPARISON_PATTERN.test(userMessage)
}

async function generateGeminiJson(systemInstruction: string, prompt: string): Promise<string> {
  const model = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!).getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction,
    generationConfig: { responseMimeType: 'application/json' },
  })
  const result = await model.generateContent(prompt)
  return result.response.text().trim()
}

function parseJsonObject<T>(raw: string): T | null {
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim()
    return JSON.parse(cleaned) as T
  } catch {
    try {
      const match = raw.match(/\{[\s\S]*\}/)
      if (match) return JSON.parse(match[0]) as T
    } catch {
      /* ignore */
    }
  }
  return null
}

const PLAN_SYSTEM_PROMPT = [
  'You extract the structure of a consumer-market comparison request for a US real-estate analytics agent.',
  'Return strict JSON: {"businessType": string, "businessLabel": string, "overtureCategories": string[], "cityA": {"name": string, "stateAbbr": string}, "cityB": {"name": string, "stateAbbr": string}, "confidence": number}.',
  '- businessType: short noun for the business being evaluated (e.g. "cafe", "gym").',
  '- businessLabel: plural display label for that business supply (e.g. "Coffee shops & cafes").',
  `- overtureCategories: 1-4 values chosen ONLY from this list that best represent that business: ${OVERTURE_SIGNAL_CATEGORY_NAMES.join(', ')}.`,
  '- cityA/cityB: the two US cities being compared, with two-letter state abbreviations.',
  '- confidence: 0-1 that this is a consumer-market comparison between exactly two US cities.',
  'If the request is not a two-city US consumer-market comparison, return {"confidence": 0}.',
].join('\n')

function normalizePlan(value: unknown): ConsumerMarketPlan | null {
  if (!value || typeof value !== 'object') return null
  const plan = value as Partial<ConsumerMarketPlan> & { confidence?: number }
  const confidence = typeof plan.confidence === 'number' ? plan.confidence : 0
  if (confidence < 0.5) return null

  const allowed = new Set<string>(OVERTURE_SIGNAL_CATEGORY_NAMES)
  const categories = Array.isArray(plan.overtureCategories)
    ? plan.overtureCategories.filter((entry): entry is string => typeof entry === 'string' && allowed.has(entry))
    : []

  function normalizeCity(city: unknown): ConsumerMarketPlanCity | null {
    if (!city || typeof city !== 'object') return null
    const candidate = city as Partial<ConsumerMarketPlanCity>
    if (typeof candidate.name !== 'string' || typeof candidate.stateAbbr !== 'string') return null
    const stateAbbr = candidate.stateAbbr.trim().toUpperCase()
    if (!STATE_ABBR_TO_FIPS[stateAbbr]) return null
    const name = candidate.name.trim()
    if (!name) return null
    return { name, stateAbbr }
  }

  const cityA = normalizeCity(plan.cityA)
  const cityB = normalizeCity(plan.cityB)
  if (!cityA || !cityB || categories.length === 0) return null
  if (typeof plan.businessType !== 'string' || typeof plan.businessLabel !== 'string') return null

  return {
    businessType: plan.businessType.trim() || 'business',
    businessLabel: plan.businessLabel.trim() || 'Locations',
    overtureCategories: categories,
    cityA,
    cityB,
    confidence,
  }
}

async function defaultFetchCensusRows(url: string): Promise<string[][]> {
  const key = process.env.CENSUS_API_KEY
  if (!key) throw new Error('CENSUS_API_KEY is not configured')
  const res = await fetch(`${url}&key=${key}`, { signal: AbortSignal.timeout(12000) })
  if (!res.ok) throw new Error(`Census API request failed: ${res.status}`)
  return (await res.json()) as string[][]
}

/** "Austin city, Texas" -> "austin"; also strips town/village/CDP/etc. suffixes. */
function normalizeCensusPlaceName(name: string): string {
  return name
    .split(',')[0]
    .trim()
    .toLowerCase()
    .replace(/\s+(city|town|village|borough|municipality|cdp|consolidated government|metro government|metropolitan government|urban county)$/i, '')
    .trim()
}

interface CensusPlaceRow {
  censusName: string
  placeFips: string
  values: Record<string, string>
}

function matchCensusPlace(rows: string[][], cityName: string): CensusPlaceRow | null {
  if (rows.length < 2) return null
  const header = rows[0]
  const nameIndex = header.indexOf('NAME')
  const placeIndex = header.indexOf('place')
  if (nameIndex < 0 || placeIndex < 0) return null

  const target = cityName.trim().toLowerCase()
  for (const row of rows.slice(1)) {
    if (normalizeCensusPlaceName(row[nameIndex] ?? '') !== target) continue
    const values: Record<string, string> = {}
    header.forEach((column, index) => {
      values[column] = row[index]
    })
    return { censusName: row[nameIndex], placeFips: row[placeIndex], values }
  }
  return null
}

function parseCensusNumber(value: string | undefined): number | null {
  if (value == null) return null
  const parsed = Number(value)
  // The ACS uses large negative sentinels (-666666666 etc.) for suppressed values.
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}

async function fetchCityCensusEvidence(
  city: ConsumerMarketPlanCity,
  fetchCensusRows: (url: string) => Promise<string[][]>
): Promise<Omit<ConsumerMarketCityEvidence, 'poiCount' | 'corePoint'>> {
  const stateFips = STATE_ABBR_TO_FIPS[city.stateAbbr]
  const base = `https://api.census.gov/data/${ACS_VINTAGE}/acs/acs1`
  const suffix = `&for=place:*&in=state:${stateFips}`
  const [subjectRows, detailRows] = await Promise.all([
    fetchCensusRows(`${base}/subject?get=NAME,S0801_C01_013E${suffix}`),
    fetchCensusRows(`${base}?get=NAME,B19013_001E,B01003_001E${suffix}`),
  ])

  const subject = matchCensusPlace(subjectRows, city.name)
  const detail = matchCensusPlace(detailRows, city.name)
  if (!subject || !detail) {
    throw new Error(
      `${city.name}, ${city.stateAbbr} is not in the ACS ${ACS_VINTAGE} 1-year place series (it covers places with 65k+ residents).`
    )
  }

  return {
    name: city.name,
    stateAbbr: city.stateAbbr,
    geoId: `160XX00US${stateFips}${detail.placeFips}`,
    censusName: detail.censusName,
    workFromHomePct: parseCensusNumber(subject.values.S0801_C01_013E),
    medianHouseholdIncome: parseCensusNumber(detail.values.B19013_001E),
    population: parseCensusNumber(detail.values.B01003_001E),
  }
}

function censusTableUrl(table: 'S0801' | 'B19013', geoId: string): string {
  if (table === 'S0801') return `https://data.census.gov/table/ACSST1Y${ACS_VINTAGE}.S0801?g=${geoId}`
  return `https://data.census.gov/table/ACSDT1Y${ACS_VINTAGE}.B19013?g=${geoId}`
}

function buildCensusCitation(args: {
  idPrefix: string
  table: 'S0801' | 'B19013'
  city: ConsumerMarketCityEvidence
  noteLabel: string
}): ScoutChartCitation {
  return {
    id: `${args.idPrefix}:${args.city.geoId}`,
    label: `Census ACS ${args.table} — ${args.city.name}`,
    sourceType: 'public_dataset',
    scope: args.city.censusName,
    periodLabel: ACS_PERIOD_LABEL,
    note: `${args.noteLabel}. ${censusTableUrl(args.table, args.city.geoId)}`,
  }
}

const CITY_A_COLOR = '#D76B3D'
const CITY_B_COLOR = '#7A8FA6'

function overtureExplorerUrl(point: { lat: number; lng: number }): string {
  return `https://explore.overturemaps.org/#15/${point.lat.toFixed(4)}/${point.lng.toFixed(4)}`
}

/** Published industry benchmarks shown alongside (never instead of) the live chart values. */
const CATEGORY_BENCHMARK_CITATIONS: Array<{ categories: string[]; citation: ScoutChartCitation }> = [
  {
    categories: ['coffee_shop', 'cafe'],
    citation: {
      id: 'benchmark:clever-best-coffee-cities-2024',
      label: 'Industry benchmark — Clever Best Coffee Cities (2024)',
      sourceType: 'public_dataset',
      scope: '50 largest U.S. metros',
      note: 'Published metro-level coffee-shop density rankings for context; chart values come from the live Overture snapshot above. https://listwithclever.com/research/best-coffee-cities/#worst',
    },
  },
]

function benchmarkCitationsForCategories(categories: string[]): ScoutChartCitation[] {
  const selected = new Set(categories)
  return CATEGORY_BENCHMARK_CITATIONS.filter((entry) =>
    entry.categories.some((category) => selected.has(category))
  ).map((entry) => entry.citation)
}

function buildWfhChart(cityA: ConsumerMarketCityEvidence, cityB: ConsumerMarketCityEvidence): ScoutChartOutput | null {
  if (cityA.workFromHomePct == null || cityB.workFromHomePct == null) return null
  return normalizeScoutChartOutput({
    kind: 'bar',
    title: `Work-from-home rate: ${cityA.name} vs ${cityB.name}`,
    subtitle: 'Share of workers 16+ who worked from home (city level).',
    summary: 'Remote workers are a core weekday customer base for neighborhood-serving businesses.',
    placeholder: false,
    confidenceLabel: ACS_PERIOD_LABEL,
    xAxis: { key: 'city', label: 'City' },
    yAxis: { label: 'Worked from home', valueFormat: 'percent' },
    series: [
      {
        key: 'wfh_rate',
        label: 'Work-from-home rate',
        color: CITY_A_COLOR,
        points: [
          { x: cityA.name, y: cityA.workFromHomePct },
          { x: cityB.name, y: cityB.workFromHomePct },
        ],
      },
    ],
    citations: [
      buildCensusCitation({ idPrefix: 'census:acs-s0801', table: 'S0801', city: cityA, noteLabel: 'Workers 16+ who worked from home' }),
      buildCensusCitation({ idPrefix: 'census:acs-s0801', table: 'S0801', city: cityB, noteLabel: 'Workers 16+ who worked from home' }),
    ],
  })
}

function roundPer100k(value: number): number {
  return Math.round(value * 10) / 10
}

function buildSupplyDensityChart(
  plan: ConsumerMarketPlan,
  cityA: ConsumerMarketCityEvidence,
  cityB: ConsumerMarketCityEvidence
): ScoutChartOutput | null {
  if (cityA.poiCount == null || cityB.poiCount == null) return null
  const hasPopulation = cityA.population != null && cityB.population != null
  const points = hasPopulation
    ? [
        { x: cityA.name, y: roundPer100k((cityA.poiCount / cityA.population!) * 100000) },
        { x: cityB.name, y: roundPer100k((cityB.poiCount / cityB.population!) * 100000) },
      ]
    : [
        { x: cityA.name, y: cityA.poiCount },
        { x: cityB.name, y: cityB.poiCount },
      ]

  return normalizeScoutChartOutput({
    kind: 'bar',
    title: hasPopulation
      ? `${plan.businessLabel} per 100k residents (city core)`
      : `${plan.businessLabel} near the city core`,
    subtitle: `Overture POIs within ${POI_RADIUS_METERS}m of each city core (categories: ${plan.overtureCategories.join(', ')}).`,
    summary: hasPopulation
      ? 'Core-area supply normalized by citywide population — existing competition and category demand signal.'
      : 'Core-area supply counts — existing competition and category demand signal.',
    placeholder: false,
    confidenceLabel: 'Overture current snapshot',
    xAxis: { key: 'city', label: 'City' },
    yAxis: {
      label: hasPopulation ? 'Core POIs per 100k residents' : 'POI count',
      valueFormat: 'number',
    },
    series: [
      {
        key: 'supply_density',
        label: plan.businessLabel,
        color: CITY_A_COLOR,
        points,
      },
    ],
    citations: [
      {
        id: `overture:consumer-market:${plan.businessType}:${cityA.geoId}:${cityB.geoId}`,
        label: 'Overture Maps Places',
        sourceType: 'public_dataset',
        scope: `${cityA.name} and ${cityB.name} core anchors`,
        note:
          cityA.corePoint && cityB.corePoint
            ? `Live POI snapshot within ${POI_RADIUS_METERS}m of each core; categories: ${plan.overtureCategories.join(', ')}. Browse the data: ${overtureExplorerUrl(cityA.corePoint)} (${cityA.name}) and ${overtureExplorerUrl(cityB.corePoint)} (${cityB.name}).`
            : `Live POI snapshot within ${POI_RADIUS_METERS}m of each core; categories: ${plan.overtureCategories.join(', ')}. https://docs.overturemaps.org/guides/places/`,
      },
      ...benchmarkCitationsForCategories(plan.overtureCategories),
      ...(hasPopulation
        ? [
            {
              id: `derived:per-100k:${cityA.geoId}:${cityB.geoId}`,
              label: 'Per-100k normalization',
              sourceType: 'derived' as const,
              note: `Core POI counts divided by citywide population (Census ACS B01003, ${ACS_PERIOD_LABEL}). https://data.census.gov/table/ACSDT1Y${ACS_VINTAGE}.B01003?g=${cityA.geoId} and https://data.census.gov/table/ACSDT1Y${ACS_VINTAGE}.B01003?g=${cityB.geoId}`,
            },
          ]
        : []),
    ],
  })
}

function buildIncomeChart(cityA: ConsumerMarketCityEvidence, cityB: ConsumerMarketCityEvidence): ScoutChartOutput | null {
  if (cityA.medianHouseholdIncome == null || cityB.medianHouseholdIncome == null) return null
  return normalizeScoutChartOutput({
    kind: 'bar',
    title: `Median household income: ${cityA.name} vs ${cityB.name}`,
    subtitle: 'Household spending power behind discretionary purchases (city level).',
    summary: 'Median household income proxies the discretionary budget available to the local customer base.',
    placeholder: false,
    confidenceLabel: ACS_PERIOD_LABEL,
    xAxis: { key: 'city', label: 'City' },
    yAxis: { label: 'Median household income', valueFormat: 'currency' },
    series: [
      {
        key: 'median_income',
        label: 'Median household income',
        color: CITY_B_COLOR,
        points: [
          { x: cityA.name, y: cityA.medianHouseholdIncome },
          { x: cityB.name, y: cityB.medianHouseholdIncome },
        ],
      },
    ],
    citations: [
      buildCensusCitation({ idPrefix: 'census:acs-b19013', table: 'B19013', city: cityA, noteLabel: 'Median household income' }),
      buildCensusCitation({ idPrefix: 'census:acs-b19013', table: 'B19013', city: cityB, noteLabel: 'Median household income' }),
    ],
  })
}

const SYNTHESIS_SYSTEM_PROMPT = [
  'You are Scout, a grounded real-estate analytics agent. You receive fetched metric values for a two-city consumer-market comparison.',
  'Return strict JSON: {"message": string, "keyFindings": string[], "caveats": string[]}.',
  '- message: 2-3 sentence analyst takeaway comparing the two cities for the stated business type.',
  '- keyFindings: 3 short bullets, one per metric, each quoting the provided numbers.',
  '- caveats: 1-2 short bullets about data scope (city vs core radius, ACS coverage).',
  'Use ONLY the numbers provided. Never invent values, rankings, or additional sources. No em dashes.',
].join('\n')

function buildSynthesisPrompt(plan: ConsumerMarketPlan, cityA: ConsumerMarketCityEvidence, cityB: ConsumerMarketCityEvidence): string {
  return JSON.stringify({
    businessType: plan.businessType,
    metrics: {
      workFromHomePct: { [cityA.name]: cityA.workFromHomePct, [cityB.name]: cityB.workFromHomePct, source: `Census ACS S0801, ${ACS_PERIOD_LABEL}` },
      corePoiCount: {
        [cityA.name]: cityA.poiCount,
        [cityB.name]: cityB.poiCount,
        source: `Overture POIs within ${POI_RADIUS_METERS}m of each city core`,
        categories: plan.overtureCategories,
      },
      population: { [cityA.name]: cityA.population, [cityB.name]: cityB.population, source: `Census ACS B01003, ${ACS_PERIOD_LABEL}` },
      medianHouseholdIncomeUsd: { [cityA.name]: cityA.medianHouseholdIncome, [cityB.name]: cityB.medianHouseholdIncome, source: `Census ACS B19013, ${ACS_PERIOD_LABEL}` },
    },
  })
}

function normalizeSynthesis(value: unknown): ConsumerMarketSynthesis | null {
  if (!value || typeof value !== 'object') return null
  const synthesis = value as Partial<ConsumerMarketSynthesis>
  if (typeof synthesis.message !== 'string' || !synthesis.message.trim()) return null
  return {
    message: synthesis.message.trim(),
    keyFindings: Array.isArray(synthesis.keyFindings)
      ? synthesis.keyFindings.filter((entry): entry is string => typeof entry === 'string').slice(0, 4)
      : [],
    caveats: Array.isArray(synthesis.caveats)
      ? synthesis.caveats.filter((entry): entry is string => typeof entry === 'string').slice(0, 3)
      : [],
  }
}

function buildFallbackSynthesis(
  plan: ConsumerMarketPlan,
  cityA: ConsumerMarketCityEvidence,
  cityB: ConsumerMarketCityEvidence
): ConsumerMarketSynthesis {
  return {
    message: `Here is the consumer-market comparison for a ${plan.businessType} in ${cityA.name} and ${cityB.name}: work-from-home rate, ${plan.businessLabel.toLowerCase()} supply near each core, and median household income, each with its public source.`,
    keyFindings: [
      `Work-from-home share: ${cityA.name} ${cityA.workFromHomePct ?? 'n/a'}% vs ${cityB.name} ${cityB.workFromHomePct ?? 'n/a'}%.`,
      `${plan.businessLabel} within ${POI_RADIUS_METERS}m of the core: ${cityA.name} ${cityA.poiCount ?? 'n/a'} vs ${cityB.name} ${cityB.poiCount ?? 'n/a'}.`,
      `Median household income: ${cityA.name} $${(cityA.medianHouseholdIncome ?? 0).toLocaleString('en-US')} vs ${cityB.name} $${(cityB.medianHouseholdIncome ?? 0).toLocaleString('en-US')}.`,
    ],
    caveats: ['WFH and income are city-level ACS values; supply counts cover a fixed core radius.'],
  }
}

async function fetchCityPoiSnapshot(
  city: ConsumerMarketPlanCity,
  categories: string[],
  geocodeCity: NonNullable<ConsumerMarketDependencies['geocodeCity']>,
  fetchPois: NonNullable<ConsumerMarketDependencies['fetchPois']>
): Promise<{ count: number; lat: number; lng: number } | null> {
  const located = await geocodeCity(`${city.name}, ${city.stateAbbr}`)
  if (!located) return null
  const places = await fetchPois(located.lat, located.lng, POI_RADIUS_METERS, categories.join(','), POI_FETCH_LIMIT)
  return { count: places.length, lat: located.lat, lng: located.lng }
}

export async function buildConsumerMarketComparison(
  userMessage: string,
  dependencies: ConsumerMarketDependencies = {}
): Promise<ConsumerMarketComparisonOutcome | null> {
  if (!hasConsumerMarketComparisonIntent(userMessage)) return null

  const generateJson = dependencies.generateJson ?? generateGeminiJson
  const fetchCensusRows = dependencies.fetchCensusRows ?? defaultFetchCensusRows
  const geocodeCity =
    dependencies.geocodeCity ??
    (async (query: string) => {
      const result = await geocodeAddressForward(query)
      return result ? { lat: result.lat, lng: result.lng } : null
    })
  const fetchPois =
    dependencies.fetchPois ??
    ((lat: number, lng: number, radius: number, categories: string, limit: number) =>
      fetchOverturePlaces(lat, lng, radius, categories, limit))

  const toolCalls: AgentTraceToolRow[] = []

  // Step 1: the model plans the comparison (business type, cities, POI categories).
  const planRaw = await generateJson(PLAN_SYSTEM_PROMPT, userMessage)
  const plan = normalizePlan(parseJsonObject(planRaw))
  toolCalls.push({
    name: 'gemini.plan',
    argsPreview: userMessage.slice(0, 120),
    resultPreview: plan
      ? `${plan.businessType}: ${plan.cityA.name}, ${plan.cityA.stateAbbr} vs ${plan.cityB.name}, ${plan.cityB.stateAbbr} (${plan.overtureCategories.join(', ')})`
      : 'low confidence',
    ok: plan != null,
  })
  if (!plan) return null

  // Step 2: live evidence fetches (Census ACS, geocode, Overture POIs) in parallel.
  const [censusA, censusB, poiA, poiB] = await Promise.all([
    fetchCityCensusEvidence(plan.cityA, fetchCensusRows),
    fetchCityCensusEvidence(plan.cityB, fetchCensusRows),
    fetchCityPoiSnapshot(plan.cityA, plan.overtureCategories, geocodeCity, fetchPois),
    fetchCityPoiSnapshot(plan.cityB, plan.overtureCategories, geocodeCity, fetchPois),
  ])

  const cityA: ConsumerMarketCityEvidence = {
    ...censusA,
    poiCount: poiA?.count ?? null,
    corePoint: poiA ? { lat: poiA.lat, lng: poiA.lng } : null,
  }
  const cityB: ConsumerMarketCityEvidence = {
    ...censusB,
    poiCount: poiB?.count ?? null,
    corePoint: poiB ? { lat: poiB.lat, lng: poiB.lng } : null,
  }
  toolCalls.push({
    name: 'census.acs',
    argsPreview: `S0801 + B19013/B01003, places in ${plan.cityA.stateAbbr}/${plan.cityB.stateAbbr}`,
    resultPreview: `${cityA.name} WFH ${cityA.workFromHomePct}% income $${cityA.medianHouseholdIncome}; ${cityB.name} WFH ${cityB.workFromHomePct}% income $${cityB.medianHouseholdIncome}`,
    ok: true,
  })
  toolCalls.push({
    name: 'overture.places',
    argsPreview: `${plan.overtureCategories.join(',')} within ${POI_RADIUS_METERS}m of each core`,
    resultPreview: `${cityA.name}: ${cityA.poiCount ?? 'n/a'}; ${cityB.name}: ${cityB.poiCount ?? 'n/a'}`,
    ok: poiA != null && poiB != null,
  })

  const charts = [
    buildWfhChart(cityA, cityB),
    buildSupplyDensityChart(plan, cityA, cityB),
    buildIncomeChart(cityA, cityB),
  ].filter((chart): chart is ScoutChartOutput => chart != null)
  if (charts.length === 0) {
    throw new Error('No consumer-market metrics could be grounded for that city pair.')
  }

  // Step 3: the model writes the takeaways from the fetched values only.
  let synthesis: ConsumerMarketSynthesis | null = null
  try {
    const synthesisRaw = await generateJson(SYNTHESIS_SYSTEM_PROMPT, buildSynthesisPrompt(plan, cityA, cityB))
    synthesis = normalizeSynthesis(parseJsonObject(synthesisRaw))
    toolCalls.push({
      name: 'gemini.synthesize',
      argsPreview: 'fetched metric values',
      resultPreview: synthesis ? synthesis.message.slice(0, 120) : 'unparseable',
      ok: synthesis != null,
    })
  } catch {
    toolCalls.push({ name: 'gemini.synthesize', argsPreview: 'fetched metric values', resultPreview: 'failed', ok: false })
  }
  const finalSynthesis = synthesis ?? buildFallbackSynthesis(plan, cityA, cityB)

  const [primaryChart, ...companionCharts] = charts
  const allCitations = charts.flatMap((chart) => chart.citations)

  return {
    message: finalSynthesis.message,
    trace: {
      summary: `${cityA.name} versus ${cityB.name} consumer market for a ${plan.businessType}`,
      taskType: 'compare_segments',
      methodology:
        'Scout ran the agentic consumer-market loop: Gemini planned the comparison (business type, cities, POI categories), live tools fetched Census ACS work-from-home and income values plus an Overture core-radius supply snapshot, and Gemini synthesized the takeaways from the fetched values only.',
      keyFindings: finalSynthesis.keyFindings,
      evidence: [
        `Census ACS ${ACS_VINTAGE} 1-year: S0801 work-from-home share, B19013 median household income, B01003 population.`,
        `Overture current POI snapshot within ${POI_RADIUS_METERS}m of each geocoded city core (categories: ${plan.overtureCategories.join(', ')}).`,
        'All chart values come from these live fetches; the model only planned and summarized.',
      ],
      caveats: finalSynthesis.caveats.length
        ? finalSynthesis.caveats
        : ['WFH and income are city-level ACS values; supply counts cover a fixed core radius.'],
      nextQuestions: [
        `Ask which ${cityA.name} neighborhoods have the strongest ${plan.businessType} demand signals.`,
        'Ask to compare core retail context for the same cities for the broader supply view.',
      ],
      citations: allCitations,
      toolCalls,
    },
    chart: primaryChart,
    companionOutputs: companionCharts.map((chart) => ({ kind: 'chart' as const, chart })),
  }
}
