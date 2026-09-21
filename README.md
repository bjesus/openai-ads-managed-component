# OpenAI Ads Measurement Managed Component

An experimental [Managed Component](https://managedcomponents.dev) that sends
website conversion events to the OpenAI Ads Measurement endpoint for
attribution to ads in ChatGPT.

This project reproduces behavior observed from the OpenAI Measurement Pixel. It
is not an official OpenAI project.

## Configuration

### Pixel ID

`pixelId` is required. It is the OpenAI Ads Pixel ID associated with each
measurement request.

## Supported Events

The component maps Managed Component events to the following provider events:

| Managed Component event | OpenAI event |
| --- | --- |
| `pageview` | `page_viewed` |
| `ecommerce` | The value of `event.name` |
| `event` | The value of `event.name` |
| `conversion` | The value of `event.name` |

Captured standard event names include:

- `contents_viewed`
- `items_added`
- `checkout_started`
- `order_created`
- `lead_created`
- `registration_completed`
- `appointment_scheduled`
- `subscription_created`
- `trial_started`
- `custom`

## Event Fields

Fields can be supplied directly in `event.payload`. Ecommerce fields can also
be supplied in `event.payload.ecommerce`.

| Field | Description |
| --- | --- |
| `event_id` | Provider event identifier used for deduplication. A UUID is generated when omitted. |
| `contents` | Product or page content records. |
| `amount` | Event amount in the currency's minor unit. |
| `currency` | Currency code associated with `amount`. |
| `plan_id` | Plan identifier for subscription, trial, and custom events. |
| `custom_event_name` | Provider-facing name for a `custom` event. |
| `opt_out` | Provider opt-out flag. |

The source page URL is added automatically. Query parameters are excluded from
that URL because attribution is carried separately.

## User Matching

The component accepts semantic field names and provider-native aliases. User
fields may be top-level, nested under `user` or `user.in`, or included in the
ecommerce object.

| Input | Provider field | Handling |
| --- | --- | --- |
| `external_id` or `eid` | `eid` | Normalized and SHA-256 hashed |
| `email` or `em` | `em` | Normalized and SHA-256 hashed |
| `first_name` or `fn` | `fn` | Normalized and SHA-256 hashed |
| `last_name` or `ln` | `ln` | Normalized and SHA-256 hashed |
| `phone_number` or `ph` | `ph` | Normalized and SHA-256 hashed |
| `country` or `co` | `co` | Sent as provided |
| `city` or `ct` | `ct` | Sent as provided |
| `postal_code` or `pc` | `pc` | Sent as provided |
| `state`, `region`, or `rg` | `rg` | Sent as provided |

Raw values for hashed identifiers are not sent to OpenAI.

## Attribution And Storage

The component reads the `oppref` query parameter and persists it in client
storage for subsequent events. It also creates and persists an `obref` browser
reference when one does not already exist. This requires the
`access_client_kv` permission declared in `manifest.json`.

Measurement requests are emitted from the browser to
`https://bzr.openai.com/v1/sdk/events`, requiring the
`client_network_requests` permission.

## Development

Requires Node.js 18 or newer.

```sh
npm install
npm test
npm run build
```

## Protocol Scope

The implementation was generated and verified against captured OpenAI
Measurement Pixel request behavior using a synthetic Pixel ID. Request
construction is covered; backend acceptance, campaign attribution, and Ads
Manager reporting are not asserted.

## License

Licensed under the [Apache License](./LICENSE).
