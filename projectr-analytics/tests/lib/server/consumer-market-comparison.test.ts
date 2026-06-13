import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildConsumerMarketComparison,
  hasConsumerMarketComparisonIntent,
  type ConsumerMarketDependencies,
} from '@/lib/server/consumer-market-comparison'
import { buildConsumerMarketResponseForTest } from '@/lib/server/agent-pipeline'

const PLAN_JSON = JSON.stringify({
  businessType: 'cafe',
  businessLabel: 'Coffee shops & cafes',
  overtureCategories: ['coffee_shop', 'cafe'],
  cityA: { name: 'Austin', stateAbbr: 'TX' },
  cityB: { name: 'Houston', stateAbbr: 'TX' },
  confidence: 0.95,
})

const SYNTHESIS_JSON = JSON.stringify({
  message: 'Austin pairs a much larger remote-work base with higher household incomes, while Houston offers a thinner core cafe supply.',
  keyFindings: [
    'Work-from-home share: Austin 24.8% vs Houston 10.9%.',
    'Core cafe POIs: Austin 41 vs Houston 18.',
    'Median household income: Austin $93,658 vs Houston $64,813.',
  ],
  caveats: ['Supply counts cover a fixed 1200m core radius.'],
})

function fixtureCensusRows(url: string): string[][] {
  if (url.includes('/subject')) {
    return [
      ['NAME', 'S0801_C01_013E', 'state', 'place'],
      ['Austin city, Texas', '24.8', '48', '05000'],
      ['Houston city, Texas', '10.9', '48', '35000'],
      ['El Paso city, Texas', '6.1', '48', '24000'],
    ]
  }
  return [
    ['NAME', 'B19013_001E', 'B01003_001E', 'state', 'place'],
    ['Austin city, Texas', '93658', '993771', '48', '05000'],
    ['Houston city, Texas', '64813', '2387910', '48', '35000'],
    ['El Paso city, Texas', '55000', '677000', '48', '24000'],
  ]
}

function fixtureDependencies(overrides: Partial<ConsumerMarketDependencies> = {}): ConsumerMarketDependencies {
  return {
    generateJson: async (systemInstruction) =>
      systemInstruction.includes('extract the structure') ? PLAN_JSON : SYNTHESIS_JSON,
    fetchCensusRows: async (url) => fixtureCensusRows(url),
    geocodeCity: async (query) =>
      query.startsWith('Austin') ? { lat: 30.2672, lng: -97.7431 } : { lat: 29.7604, lng: -95.3698 },
    fetchPois: async (lat) => new Array(lat > 30 ? 41 : 18).fill({}),
    ...overrides,
  }
}

test('detects consumer-market comparison intent without hijacking other prompts', () => {
  assert.equal(hasConsumerMarketComparisonIntent('Compare the consumer market for a cafe in Austin vs. Houston'), true)
  assert.equal(hasConsumerMarketComparisonIntent('compare the market for a gym in Dallas versus San Antonio'), true)
  assert.equal(hasConsumerMarketComparisonIntent('compare retail in austin vs houston'), false)
  assert.equal(hasConsumerMarketComparisonIntent('what is the consumer market like in Austin'), false)
})

test('runs the plan -> fetch -> synthesize loop and returns three sourced charts', async () => {
  const outcome = await buildConsumerMarketComparison(
    'Compare the consumer market for a cafe in Austin vs. Houston',
    fixtureDependencies()
  )
  assert.ok(outcome, 'expected an agentic consumer-market outcome')

  assert.match(outcome.message, /remote-work base/i)

  const charts = [outcome.chart, ...outcome.companionOutputs.flatMap((output) => (output.kind === 'chart' ? [output.chart] : []))]
  assert.equal(charts.length, 3)
  assert.match(charts[0].title, /work-from-home/i)
  assert.match(charts[1].title, /coffee shops & cafes per 100k/i)
  assert.match(charts[2].title, /median household income/i)

  // WFH and income values come straight from the mocked live Census rows.
  assert.deepEqual(charts[0].series[0].points.map((point) => point.y), [24.8, 10.9])
  assert.deepEqual(charts[2].series[0].points.map((point) => point.y), [93658, 64813])
  // POI counts normalized per 100k by ACS population: 41/993771 and 18/2387910.
  assert.deepEqual(charts[1].series[0].points.map((point) => point.y), [4.1, 0.8])

  for (const chart of charts) {
    assert.ok(chart.citations.length > 0, `${chart.title} must include citations`)
  }
  // Census citations carry the per-city data.census.gov table URLs.
  assert.match(charts[0].citations[0].note ?? '', /data\.census\.gov\/table\/ACSST1Y2024\.S0801\?g=160XX00US4805000/)
  assert.match(charts[2].citations[1].note ?? '', /160XX00US4835000/)

  // The supply chart links the Overture explorer at each geocoded core, plus the coffee industry benchmark.
  const supplyNotes = charts[1].citations.map((citation) => citation.note ?? '')
  assert.match(supplyNotes[0], /explore\.overturemaps\.org\/#15\/30\.2672\/-97\.7431/)
  assert.match(supplyNotes[0], /explore\.overturemaps\.org\/#15\/29\.7604\/-95\.3698/)
  const benchmark = charts[1].citations.find((citation) => citation.id.startsWith('benchmark:'))
  assert.ok(benchmark, 'coffee categories should attach the Clever benchmark citation')
  assert.match(benchmark.note ?? '', /listwithclever\.com\/research\/best-coffee-cities/)

  // The trace records the agent loop, including both model calls.
  const toolNames = outcome.trace.toolCalls?.map((row) => row.name) ?? []
  assert.deepEqual(toolNames, ['gemini.plan', 'census.acs', 'overture.places', 'gemini.synthesize'])
  assert.ok(outcome.trace.toolCalls?.every((row) => row.ok))
})

test('returns null when the model reports low confidence', async () => {
  const outcome = await buildConsumerMarketComparison(
    'Compare the consumer market for a cafe in Austin vs. Houston',
    fixtureDependencies({ generateJson: async () => JSON.stringify({ confidence: 0.1 }) })
  )
  assert.equal(outcome, null)
})

test('falls back to deterministic synthesis when the second model call fails', async () => {
  let calls = 0
  const outcome = await buildConsumerMarketComparison(
    'Compare the consumer market for a cafe in Austin vs. Houston',
    fixtureDependencies({
      generateJson: async () => {
        calls += 1
        if (calls === 1) return PLAN_JSON
        throw new Error('model unavailable')
      },
    })
  )
  assert.ok(outcome)
  assert.match(outcome.message, /consumer-market comparison for a cafe/i)
  assert.equal(outcome.trace.toolCalls?.at(-1)?.ok, false)
})

test('pipeline surfaces a grounding failure when a city is outside ACS coverage', async () => {
  const response = await buildConsumerMarketResponseForTest(
    'Compare the consumer market for a cafe in Smallville vs. Houston',
    {
      consumerMarket: fixtureDependencies({
        generateJson: async (systemInstruction) =>
          systemInstruction.includes('extract the structure')
            ? JSON.stringify({
                businessType: 'cafe',
                businessLabel: 'Coffee shops & cafes',
                overtureCategories: ['coffee_shop'],
                cityA: { name: 'Smallville', stateAbbr: 'KS' },
                cityB: { name: 'Houston', stateAbbr: 'TX' },
                confidence: 0.9,
              })
            : SYNTHESIS_JSON,
        fetchCensusRows: async (url) => (url.includes('state:48') ? fixtureCensusRows(url) : [['NAME', 'S0801_C01_013E', 'state', 'place']]),
      }),
    }
  )
  assert.ok(response)
  assert.equal(response.chart, null)
  assert.match(response.message, /could not ground it/i)
  assert.match(response.message, /65k\+/)
})

test('pipeline ignores prompts without consumer-market intent', async () => {
  assert.equal(await buildConsumerMarketResponseForTest('compare retail in austin vs houston'), null)
  assert.equal(await buildConsumerMarketResponseForTest('coffee shops near me'), null)
})
