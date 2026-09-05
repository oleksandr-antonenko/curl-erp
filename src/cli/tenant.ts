#!/usr/bin/env node
/**
 * Operations CLI for tenants.
 *
 * Provisioning, migrating and suspending are the things an operator does at
 * three in the morning, so they are commands rather than steps in a runbook:
 * a runbook can be performed half-way, a command cannot.
 */
import { parseArgs } from 'node:util'
import type { ControlPlane } from '../tenancy/control-plane.js'
import { TenantDatabaseRegistry } from '../tenancy/database-registry.js'
import { migrateAllTenants, migrateTenant, reportSchemaVersions } from '../tenancy/migrations.js'
import {
  activateTenant,
  databaseNameFor,
  deactivateTenant,
  deleteTenant,
  provisionTenant,
} from '../tenancy/provisioning.js'
import { adminDatabaseUrlFromEnv, controlPlaneFromEnv } from '../tenancy/runtime.js'

const USAGE = `Usage: erp-tenant <command> [options]

Commands:
  list                          Show every registered tenant and its schema version
  provision <id>                Create the database, migrate it and register the tenant
  migrate [<id>]                Apply pending migrations to one tenant, or to all
  deactivate <id>               Stop access, keep the data
  activate <id>                 Resume access
  delete <id> --confirm <id>    Remove the tenant and destroy its database

Options:
  --name <text>                 Display name (provision)
  --host <name>                 Host this tenant answers on; repeatable (provision)
  --entitlement <id>            Commercial module the tenant has bought; repeatable
  --stored-url <url>            Connection string to record, e.g. \${TENANT_DB_URL}
  --confirm <id>                Required by delete
  --json                        Machine-readable output

Environment:
  CONTROL_PLANE_FILE            Tenant registry file
  ADMIN_DATABASE_URL            Connection able to CREATE DATABASE
`

interface Output {
  print(value: unknown, text: string): void
}

function makeOutput(asJson: boolean): Output {
  return {
    print(value, text) {
      // stdout is the command's result; diagnostics go to stderr.
      process.stdout.write(asJson ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`)
    },
  }
}

async function listCommand(controlPlane: ControlPlane, output: Output): Promise<void> {
  const registry = new TenantDatabaseRegistry(controlPlane)
  try {
    const versions = await reportSchemaVersions(controlPlane, registry)
    const tenants = await controlPlane.list()
    const rows = tenants.map((tenant) => {
      const entry = versions.find((candidate) => candidate.tenantId === tenant.id)
      return {
        id: tenant.id,
        name: tenant.name,
        status: tenant.status,
        hosts: tenant.hosts,
        schema:
          entry?.version === undefined || entry.version === null
            ? 'unreachable'
            : `${entry.version.applied}/${entry.version.required}`,
        ...(entry?.error === undefined ? {} : { error: entry.error }),
      }
    })

    const text =
      rows.length === 0
        ? 'No tenants registered.'
        : rows
            .map(
              (row) =>
                `${row.id.padEnd(20)} ${row.status.padEnd(10)} schema ${row.schema.padEnd(8)} ${row.hosts.join(', ')}`,
            )
            .join('\n')
    output.print(rows, text)
  } finally {
    await registry.close()
  }
}

interface CommandContext {
  readonly controlPlane: ControlPlane
  readonly tenantId: string | undefined
  readonly values: {
    name?: string | undefined
    host?: string[] | undefined
    entitlement?: string[] | undefined
    'stored-url'?: string | undefined
    confirm?: string | undefined
  }
  readonly output: Output
}

function requireTenantId(context: CommandContext, command: string): string {
  if (context.tenantId === undefined) throw new Error(`${command} requires a tenant id`)
  return context.tenantId
}

async function provisionCommand(context: CommandContext): Promise<number> {
  const id = requireTenantId(context, 'provision')
  const { values } = context
  const result = await provisionTenant({
    id,
    adminDatabaseUrl: adminDatabaseUrlFromEnv(),
    controlPlane: context.controlPlane,
    ...(values.name === undefined ? {} : { name: values.name }),
    ...(values.host === undefined ? {} : { hosts: values.host }),
    ...(values.entitlement === undefined ? {} : { entitlements: values.entitlement }),
    ...(values['stored-url'] === undefined ? {} : { storedDatabaseUrl: values['stored-url'] }),
  })
  context.output.print(
    result,
    `Provisioned ${result.tenant.id}: database ${result.databaseName}, ` +
      `schema ${result.version.applied}/${result.version.required}`,
  )
  return 0
}

async function migrateCommand(context: CommandContext): Promise<number> {
  const registry = new TenantDatabaseRegistry(context.controlPlane)
  try {
    if (context.tenantId === undefined) {
      const report = await migrateAllTenants(context.controlPlane, registry)
      context.output.print(
        report,
        `Migrated ${report.migrated}, failed ${report.failed}, skipped ${report.skipped}`,
      )
      return report.failed > 0 ? 1 : 0
    }
    const connection = await registry.connect(context.tenantId)
    const version = await migrateTenant(connection.db)
    context.output.print(version, `${context.tenantId} is at ${version.applied}/${version.required}`)
    return 0
  } finally {
    await registry.close()
  }
}

async function deleteCommand(context: CommandContext): Promise<number> {
  const id = requireTenantId(context, 'delete')
  if (context.values.confirm === undefined) {
    throw new Error(`Deleting destroys data. Repeat the id: --confirm ${id}`)
  }
  await deleteTenant(id, {
    controlPlane: context.controlPlane,
    adminDatabaseUrl: adminDatabaseUrlFromEnv(),
    confirmTenantId: context.values.confirm,
  })
  context.output.print({ deleted: id, database: databaseNameFor(id) }, `Deleted ${id} and its database`)
  return 0
}

const COMMANDS: Record<string, (context: CommandContext) => Promise<number>> = {
  list: async (context) => {
    await listCommand(context.controlPlane, context.output)
    return 0
  },
  provision: provisionCommand,
  migrate: migrateCommand,
  deactivate: async (context) => {
    const tenant = await deactivateTenant(context.controlPlane, requireTenantId(context, 'deactivate'))
    context.output.print(tenant, `${tenant.id} is suspended; its data is untouched`)
    return 0
  },
  activate: async (context) => {
    const tenant = await activateTenant(context.controlPlane, requireTenantId(context, 'activate'))
    context.output.print(tenant, `${tenant.id} is active`)
    return 0
  },
  delete: deleteCommand,
}

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      host: { type: 'string', multiple: true },
      entitlement: { type: 'string', multiple: true },
      'stored-url': { type: 'string' },
      confirm: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })

  const command = positionals[0]
  if (values.help === true || command === undefined) {
    process.stdout.write(USAGE)
    return command === undefined && values.help !== true ? 1 : 0
  }

  const handler = COMMANDS[command]
  if (handler === undefined) {
    process.stderr.write(`Unknown command "${command}"\n\n${USAGE}`)
    return 1
  }

  return handler({
    controlPlane: controlPlaneFromEnv(),
    tenantId: positionals[1],
    values,
    output: makeOutput(values.json === true),
  })
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`)
    process.exitCode = 1
  })
