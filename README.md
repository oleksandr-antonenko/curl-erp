# ERP core

The system of record for a small commerce business: catalog, stock, money,
counterparties and documents. Storefronts and marketplaces are adapters around
it, not the other way round.

Source-available under the [Business Source License 1.1](./LICENSE). You may run
it in production for your own business, including for any number of legal
entities you own. You may not offer it to third parties as a hosted service.
Each version becomes Apache 2.0 four years after its release.

## Why it is shaped this way

A commerce platform can tell you what is in stock. It cannot tell you what that
stock cost, what a sale earned, or which of your legal entities is about to
exceed its tax threshold. Those questions need a system of record with its own
history, and that is what this is.

Three properties are load-bearing, and each is expensive to add later:

- **A database per tenant.** One customer's books never share a table with
  another's, and a connection is resolved from the current request or job -
  never from a process-wide handle. A single-tenant installation runs the same
  code as a hosted one; only the tenant registry differs.
- **A change feed.** Every change is journalled in the same transaction that
  made it. Channel synchronisation, marketplace feeds, the search index and the
  audit trail all read that journal at their own pace, so none of them can slow
  down or break the operation that caused the change.
- **The core knows no vendors.** Channels, carriers, payment providers and
  fiscal services are interfaces. Adapters are separate packages, loaded from
  configuration; the core starts and runs with none of them installed.

## Running it

You need Node 22 or newer, PostgreSQL 17 with the `vector`, `pg_trgm` and
`unaccent` extensions, and Redis.

```bash
npm install
npm run db:up            # PostgreSQL and Redis in Docker, on non-default ports
cp .env.example .env
npm run typecheck && npm run lint && npm test
npm run test:integration # needs the database above
```

### Setting up a tenant

The tenant registry lives outside every tenant's database. For a single
installation it is a JSON file; nothing else is required.

```bash
export CONTROL_PLANE_FILE=./control-plane.json
export ADMIN_DATABASE_URL=postgres://erp:erp@127.0.0.1:55432/postgres

npx erp-tenant provision acme --name "Acme" --host shop.acme.example
npx erp-tenant list
npx erp-tenant migrate              # applies pending migrations to every tenant
npx erp-tenant deactivate acme      # stops access, keeps the data
npx erp-tenant delete acme --confirm acme
```

Credentials do not belong in a file that gets committed. Write
`"databaseUrl": "${ACME_DATABASE_URL}"` in the registry and supply the variable
to the process.

Migrations are applied per tenant and reported per tenant: one customer's
database being unreachable does not leave the rest on an old schema. A request
arriving for a tenant whose database is behind the running code is answered with
a maintenance error rather than served against a schema the code does not match.

### Backing up one customer

```bash
# Needs pg_dump and pg_restore on the PATH.
node -e "import('@erp/core/tenancy').then(async ({ backupTenant, controlPlaneFromEnv }) =>
  backupTenant('acme', { controlPlane: controlPlaneFromEnv(), outputPath: './acme.dump' }))"
```

Restoring replaces that tenant's database and requires confirming its id. No
other tenant is touched.

## Writing a sales-channel adapter

An adapter translates between the core's shapes and one shop's API. It decides
nothing: a decision taken in an adapter is a decision the next channel has to
take again, differently.

```ts
import type { SalesChannelAdapter } from '@erp/core/channels'

export function createChannelAdapter(options: Record<string, unknown>): SalesChannelAdapter {
  return {
    id: 'my-shop',
    capabilities: {
      customerGroups: false,   // cannot restrict visibility or price by group
      priceLists: false,
      stockLevels: true,
      orderStatus: true,
      stockReporting: true,    // can report its own stock, so drift is detectable
    },

    async publishProduct(product, existingExternalId) {
      // Called again with the same input on retry. Update when given an id;
      // never create a second listing.
      return { externalId: '...', variants: [{ localId: '...', externalId: '...' }] }
    },

    async unpublishProduct(externalId) {},
    async publishStock(levels) {},
    async publishPrices(prices) {},
    async fetchOrders(since) { return [] },
    async publishOrderStatus(update) {},
    async fetchStock() { return [] },
  }
}
```

Declare the capabilities honestly. A channel that says it cannot enforce customer
groups will simply not be sent products restricted to one - which is the correct
outcome, because a wholesale price on public display is a price list handed to
every competitor.

### Proving it

The contract suite takes its test primitives as arguments, so it runs under any
test runner:

```ts
import { runChannelContractTests } from '@erp/core/channels'
import { describe, expect, it } from 'vitest'

runChannelContractTests({
  describe,
  it,
  expect: expect as never,
  createAdapter: () => createChannelAdapter({}),
})
```

`MemoryChannelAdapter` in `@erp/core/channels` is the reference implementation
and is held to the same suite.

### Installing it

```bash
CHANNELS='[{"id":"my-shop","resolve":"@you/channel-my-shop","options":{"apiKey":"..."}}]'
```

An adapter that is configured but not installed is reported at startup and the
channel is marked unavailable. Everything else keeps working.

## What the core will not do

- Reference a specific channel, carrier, payment provider or fiscal service. CI
  fails the build if it does.
- Put prices, stock levels or personal data into a search index.
- Publish anything an AI feature produced without a person approving it.
- Let a channel decide that an order is paid. Money enters through a recorded
  payment; the channel is then told.

## Layout

| Path | What lives there |
| --- | --- |
| `src/tenancy` | tenants, control plane, connections, migrations, provisioning, backups, secrets |
| `src/change-feed` | the journal, consumers, cursors, parking, trimming |
| `src/auth` | permissions, roles, staff, invitations, service accounts, audit |
| `src/channels` | the channel contract, registry, mappings, queue, stock, orders, payments |
| `src/cli` | the `erp-tenant` operations command |
| `drizzle` | generated SQL migrations, applied per tenant |

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md). Contributions require agreeing to
the [CLA](../../CLA.md); without it the licence could never be changed and the
commercial modules could not be distributed, which would end the project as it
is set up.
