import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { LocalProcessRunner, type ProcessResult, type ProcessRunner } from '../tenancy/backup.js'

const run = promisify(execFile)

/** Major version of a locally installed client tool, or `null` if absent. */
async function localMajorVersion(name: string): Promise<number | null> {
  try {
    const { stdout } = await run(name, ['--version'])
    const match = /(\d+)\./.exec(stdout)
    return match?.[1] === undefined ? null : Number(match[1])
  } catch {
    return null
  }
}

/**
 * Runs the PostgreSQL client tools inside the development container when the
 * local ones are missing or too old.
 *
 * The version check is not fussiness: `pg_dump` refuses outright to dump a
 * server newer than itself, and a runner image that ships client 16 next to a
 * server 17 fails in a way that reads like a broken backup rather than a
 * mismatched toolchain. Skipping the test instead would leave the one operation
 * whose failure is discovered at the worst possible moment untested.
 */
class ContainerProcessRunner implements ProcessRunner {
  constructor(
    private readonly container: string,
    private readonly hostPort: string,
    private readonly containerPort: string,
  ) {}

  private rewrite(argument: string): string {
    return argument.includes(`:${this.hostPort}/`)
      ? argument.replace(`:${this.hostPort}/`, `:${this.containerPort}/`)
      : argument
  }

  async run(
    command: string,
    args: readonly string[],
    options: { readonly stdoutPath?: string; readonly stdinPath?: string } = {},
  ): Promise<ProcessResult> {
    const rewritten = args.map((argument) => this.rewrite(argument))
    return new LocalProcessRunner().run(
      'docker',
      ['exec', '-i', this.container, command, ...rewritten],
      options,
    )
  }
}

/** Server major version, so the client can be checked against it. */
async function serverMajorVersion(): Promise<number | null> {
  const url = process.env['TEST_ADMIN_DATABASE_URL']
  if (url === undefined || url === '') return null
  const { Client } = await import('pg')
  const client = new Client({ connectionString: url })
  try {
    await client.connect()
    const result = await client.query<{ v: string }>('show server_version')
    const match = /(\d+)\./.exec(result.rows[0]?.v ?? '')
    return match?.[1] === undefined ? null : Number(match[1])
  } catch {
    return null
  } finally {
    await client.end().catch(() => undefined)
  }
}

/** A runner able to execute pg_dump and pg_restore against this server. */
export async function pgToolRunner(): Promise<ProcessRunner> {
  const [client, server] = await Promise.all([localMajorVersion('pg_dump'), serverMajorVersion()])

  if (client !== null && (server === null || client >= server)) {
    return new LocalProcessRunner()
  }
  if (client !== null && server !== null) {
    console.warn(
      `[testing] Local pg_dump is ${String(client)} but the server is ${String(server)}; ` +
        'falling back to the development container. Install matching client tools to run them directly.',
    )
  }
  return new ContainerProcessRunner('erp-dev-postgres', '55432', '5432')
}
