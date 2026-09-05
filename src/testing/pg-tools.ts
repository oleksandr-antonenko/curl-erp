import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { LocalProcessRunner, type ProcessResult, type ProcessRunner } from '../tenancy/backup.js'

const run = promisify(execFile)

async function hasLocalBinary(name: string): Promise<boolean> {
  try {
    await run(name, ['--version'])
    return true
  } catch {
    return false
  }
}

/**
 * Runs the PostgreSQL client tools inside the development container when they
 * are not installed on the developer's machine.
 *
 * The alternative - skipping the backup test - would leave the one operation
 * whose failure is discovered at the worst possible moment untested on most
 * machines.
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
    const dockerArgs = ['exec', '-i', this.container, command, ...rewritten]
    return new LocalProcessRunner().run('docker', dockerArgs, options)
  }
}

/** A runner able to execute pg_dump and pg_restore, wherever they live. */
export async function pgToolRunner(): Promise<ProcessRunner> {
  if (await hasLocalBinary('pg_dump')) return new LocalProcessRunner()
  return new ContainerProcessRunner('erp-dev-postgres', '55432', '5432')
}
