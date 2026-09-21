import {
  ComponentSettings,
  Manager,
  MCEvent,
  MCEventListener,
} from '@managed-components/types'

const SDK_VERSION = '0.1.41'
const EVENTS_ENDPOINT = 'https://bzr.openai.com/v1/sdk/events'

interface OaiEvent {
  type: string
  id: string
  timestamp_ms: number
  source_url: string
  data: Record<string, unknown>
  custom_event_name?: string
  opt_out?: boolean
}

interface OaiPayload {
  obref: string
  oppref: string
  events: OaiEvent[]
  user?: Record<string, unknown>
}

const getEventId = (): string => {
  // SDK-generated UUID-like identifier used for deduplication
  const globalCrypto = globalThis.crypto
  if (typeof globalCrypto?.randomUUID === 'function') {
    return globalCrypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  globalCrypto?.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const sha256 = async (value: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  )
  return Array.from(new Uint8Array(digest), b =>
    b.toString(16).padStart(2, '0')
  ).join('')
}

// Semantic (Zaraz-facing) field names mapped to the provider's user.in keys.
const USER_FIELD_ALIASES: Record<string, string[]> = {
  eid: ['eid', 'external_id'],
  em: ['em', 'email'],
  fn: ['fn', 'first_name'],
  ln: ['ln', 'last_name'],
  ph: ['ph', 'phone_number'],
  co: ['co', 'country'],
  ct: ['ct', 'city'],
  pc: ['pc', 'postal_code'],
  rg: ['rg', 'state', 'region'],
}

const HASHED_USER_FIELDS = ['eid', 'em', 'fn', 'ln', 'ph'] as const
const PLAIN_USER_FIELDS = ['co', 'ct', 'pc', 'rg'] as const

// Normalization applied before hashing, derived from the captured protocol
// evidence and the field specification.
const normalizeHashedValue = (field: string, value: string): string => {
  switch (field) {
    case 'eid':
      return value.trim()
    case 'em':
      return value.trim().toLowerCase()
    case 'fn':
    case 'ln':
      return value
        .toLowerCase()
        .replace(/[\s\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g, '')
    case 'ph': {
      let normalized = value.replace(/[\s().-]/g, '').trim()
      normalized = normalized.replace(/^\+/, '')
      normalized = normalized.replace(/^0+/, '')
      return normalized
    }
    default:
      return value
  }
}

// User fields may arrive at the top level of the payload, nested under a
// `user` object, nested under `user.in`, or inside the ecommerce object;
// all shapes are accepted, using either provider keys or semantic names.
const collectUserValue = (
  field: string,
  sources: Array<Record<string, unknown>>
): unknown => {
  const aliases = USER_FIELD_ALIASES[field] ?? [field]
  for (const source of sources) {
    for (const alias of aliases) {
      const value = source[alias]
      if (value !== undefined && value !== null) {
        return value
      }
    }
  }
  return undefined
}

const buildUser = async (
  payload: Record<string, unknown>,
  ecommerce: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> => {
  const nested =
    payload.user && typeof payload.user === 'object'
      ? (payload.user as Record<string, unknown>)
      : {}
  const nestedIn =
    nested.in && typeof nested.in === 'object'
      ? (nested.in as Record<string, unknown>)
      : {}
  const ecommerceNested =
    ecommerce.user && typeof ecommerce.user === 'object'
      ? (ecommerce.user as Record<string, unknown>)
      : {}
  const ecommerceNestedIn =
    ecommerceNested.in && typeof ecommerceNested.in === 'object'
      ? (ecommerceNested.in as Record<string, unknown>)
      : {}
  const sources = [
    payload,
    nested,
    nestedIn,
    ecommerce,
    ecommerceNested,
    ecommerceNestedIn,
  ]
  const inner: Record<string, unknown> = {}
  for (const field of HASHED_USER_FIELDS) {
    const value = collectUserValue(field, sources)
    if (typeof value === 'string' && value.length > 0) {
      inner[field] = await sha256(normalizeHashedValue(field, value))
    }
  }
  for (const field of PLAIN_USER_FIELDS) {
    const value = collectUserValue(field, sources)
    if (typeof value === 'string' && value.length > 0) {
      inner[field] = value
    }
  }
  if (Object.keys(inner).length === 0) {
    return undefined
  }
  return { in: inner }
}

// Provider-facing data.type inferred from the captured protocol evidence.
const DATA_TYPES: Record<string, string> = {
  page_viewed: 'contents',
  contents_viewed: 'contents',
  items_added: 'contents',
  checkout_started: 'contents',
  order_created: 'contents',
  lead_created: 'customer_action',
  registration_completed: 'customer_action',
  appointment_scheduled: 'customer_action',
  subscription_created: 'plan_enrollment',
  trial_started: 'plan_enrollment',
  custom: 'custom',
}

const buildEvent = (
  type: string,
  sourceUrl: string,
  data: Record<string, unknown>,
  options: {
    eventId?: string
    customEventName?: string
    optOut?: boolean
  } = {}
): OaiEvent => {
  const event: OaiEvent = {
    type,
    id: options.eventId ?? getEventId(),
    timestamp_ms: Date.now(),
    source_url: sourceUrl,
    data,
  }
  if (options.customEventName !== undefined) {
    event.custom_event_name = options.customEventName
  }
  if (options.optOut !== undefined) {
    event.opt_out = options.optOut
  }
  return event
}

// Lifecycle events observed in the captured page-view batch: the SDK emits an
// initialization event followed by a diagnostic event alongside the first
// measurement event.
const buildSdkInitEvent = (sourceUrl: string): OaiEvent =>
  buildEvent('openai::sdk_init', sourceUrl, { type: 'sdk_lifecycle' })

const buildDiagnosticEvent = (sourceUrl: string): OaiEvent =>
  buildEvent('oai::diagnostic', sourceUrl, {
    config: { automatic_advanced_matching: 'not_found' },
    consent: true,
    dropped_event_count: 0,
    dropped_event_name_counts: {},
    dropped_event_phase_counts: {},
    dropped_event_reason_counts: {},
    is_first_consent_grant_in_session: true,
    is_first_visit_in_session: true,
    schema_version: 1,
    type: 'diagnostic',
  })

const postEvents = (
  client: MCEvent['client'],
  pixelId: string,
  payload: OaiPayload
) => {
  const timestamp = Date.now()
  const eventCount = Math.max(1, Math.floor(payload.events.length))
  const url = `${EVENTS_ENDPOINT}?pid=${encodeURIComponent(pixelId)}&st=oaiq-web&sv=${SDK_VERSION}&t=${timestamp}&ec=${eventCount}`
  // Client.fetch returns boolean | undefined; do not await or inspect status
  client.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
    },
    body: JSON.stringify(payload),
  })
}

const getObref = async (client: MCEvent['client']): Promise<string> => {
  let obref = await client.get('obref')
  if (!obref) {
    obref = getEventId()
    await client.set('obref', obref)
  }
  return obref
}

// The click-id arrives via the `oppref` query parameter and is persisted for
// subsequent attribution; the query parameter takes precedence when present.
const getOppref = async (client: MCEvent['client']): Promise<string> => {
  const fromQuery = client.url.searchParams.get('oppref')
  if (fromQuery) {
    await client.set('oppref', fromQuery)
    return fromQuery
  }
  const stored = await client.get('oppref')
  return stored ?? ''
}

// source_url is the page URL where the event originated, without query
// parameters (the click-id travels in the payload's `oppref` field instead).
const getSourceUrl = (client: MCEvent['client']): string => {
  return client.url.origin + client.url.pathname
}

const buildData = (
  name: string,
  payload: Record<string, unknown>,
  ecommerce: Record<string, unknown>
): Record<string, unknown> => {
  const data: Record<string, unknown> = {}
  const explicitDataType =
    typeof payload.type === 'string'
      ? payload.type
      : typeof ecommerce.type === 'string'
        ? ecommerce.type
        : undefined
  data.type = explicitDataType ?? DATA_TYPES[name] ?? 'custom'

  if (Array.isArray(ecommerce.contents)) {
    data.contents = ecommerce.contents
  } else if (Array.isArray(payload.contents)) {
    data.contents = payload.contents
  }
  if (ecommerce.amount !== undefined) {
    data.amount = ecommerce.amount
  } else if (payload.amount !== undefined) {
    data.amount = payload.amount
  }
  if (ecommerce.currency !== undefined) {
    data.currency = ecommerce.currency
  } else if (payload.currency !== undefined) {
    data.currency = payload.currency
  }
  if (ecommerce.plan_id !== undefined) {
    data.plan_id = ecommerce.plan_id
  } else if (typeof payload.plan_id === 'string') {
    data.plan_id = payload.plan_id
  }
  return data
}

const sendEvent = async (
  client: MCEvent['client'],
  pixelId: string,
  name: string,
  payload: Record<string, unknown>,
  ecommerce: Record<string, unknown>,
  options: { includeLifecycleEvents?: boolean } = {}
) => {
  const obref = await getObref(client)
  const oppref = await getOppref(client)
  const sourceUrl = getSourceUrl(client)

  const isCustom = name === 'custom'
  const customEventName = isCustom
    ? typeof payload.custom_event_name === 'string'
      ? payload.custom_event_name
      : typeof ecommerce.custom_event_name === 'string'
        ? ecommerce.custom_event_name
        : undefined
    : undefined

  const eventId =
    typeof payload.event_id === 'string'
      ? payload.event_id
      : typeof ecommerce.event_id === 'string'
        ? ecommerce.event_id
        : undefined

  const oaiEvent = buildEvent(
    name,
    sourceUrl,
    buildData(name, payload, ecommerce),
    {
      eventId,
      customEventName,
      optOut:
        typeof payload.opt_out === 'boolean' ? payload.opt_out : undefined,
    }
  )

  const events: OaiEvent[] = []
  if (options.includeLifecycleEvents) {
    events.push(buildSdkInitEvent(sourceUrl))
    events.push(buildDiagnosticEvent(sourceUrl))
  }
  events.push(oaiEvent)

  const eventPayload: OaiPayload = {
    obref,
    oppref,
    events,
  }
  const user = await buildUser(payload, ecommerce)
  if (user) {
    eventPayload.user = user
  }
  postEvents(client, pixelId, eventPayload)
}

export default async function (manager: Manager, settings: ComponentSettings) {
  const pixelId = settings.pixelId as string

  const pageviewListener: MCEventListener = async event => {
    const client = event.client
    const payload = (event.payload ?? {}) as Record<string, unknown>
    const ecommerce = (payload.ecommerce ?? {}) as Record<string, unknown>
    // The captured page-view batch carries the SDK initialization and
    // diagnostic lifecycle events alongside the measurement event.
    await sendEvent(client, pixelId, 'page_viewed', payload, ecommerce, {
      includeLifecycleEvents: true,
    })
  }
  manager.addEventListener('pageview', pageviewListener)

  const handleNamedEvent = async (event: MCEvent) => {
    const name = typeof event.name === 'string' ? event.name : ''
    if (!name) {
      return
    }
    const client = event.client
    const payload = (event.payload ?? {}) as Record<string, unknown>
    const ecommerce = (payload.ecommerce ?? {}) as Record<string, unknown>
    await sendEvent(client, pixelId, name, payload, ecommerce)
  }

  manager.addEventListener('event', handleNamedEvent)
  manager.addEventListener('ecommerce', handleNamedEvent)
  manager.addEventListener('conversion', handleNamedEvent)
}
