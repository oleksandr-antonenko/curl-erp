import { and, asc, eq } from 'drizzle-orm'
import { recordChange } from '../change-feed/record.js'
import type { Database } from '../db/client.js'
import { CatalogError, NotFoundError } from './errors.js'
import {
  ATTRIBUTE_KINDS,
  type AttributeKind,
  attributeDefinitions,
  productVariants,
  variantAttributes,
} from './schema.js'

export interface AttributeDefinition {
  readonly id: string
  readonly code: string
  readonly kind: AttributeKind
  readonly label: string | null
  readonly unit: string | null
  readonly options: readonly string[] | null
}

export type AttributeValue = string | number | boolean

export interface VariantAttribute {
  readonly code: string
  readonly kind: AttributeKind
  readonly value: AttributeValue
  readonly unit: string | null
}

/**
 * Attributes with a declared type.
 *
 * Free key-value pairs are cheaper today and useless in six months: "250",
 * "250 ml" and "250ml" stop being one value, no filter can be built on them, and
 * a bot cannot answer "is this for coloured hair" because there is no field to
 * answer from. Declaring the type once is what prevents that.
 */
export class Attributes {
  constructor(private readonly db: Database) {}

  async define(input: {
    code: string
    kind: AttributeKind
    label?: string
    unit?: string
    options?: readonly string[]
    position?: number
  }): Promise<AttributeDefinition> {
    if (!ATTRIBUTE_KINDS.includes(input.kind)) {
      throw new CatalogError(`Unknown attribute kind "${input.kind}"`)
    }
    if (input.kind === 'option' && (input.options === undefined || input.options.length === 0)) {
      throw new CatalogError(`Attribute "${input.code}" is an option list but names no options`)
    }

    const values = {
      code: input.code,
      kind: input.kind,
      label: input.label ?? null,
      unit: input.unit ?? null,
      options: input.options === undefined ? null : [...input.options],
      position: input.position ?? 0,
    }

    const [row] = await this.db
      .insert(attributeDefinitions)
      .values(values)
      .onConflictDoUpdate({ target: attributeDefinitions.code, set: values })
      .returning()
    if (row === undefined) throw new CatalogError(`Failed to define attribute "${input.code}"`)
    return toDefinition(row)
  }

  async list(): Promise<AttributeDefinition[]> {
    return (
      await this.db
        .select()
        .from(attributeDefinitions)
        .orderBy(asc(attributeDefinitions.position), asc(attributeDefinitions.code))
    ).map(toDefinition)
  }

  async findByCode(code: string): Promise<AttributeDefinition | null> {
    const [row] = await this.db
      .select()
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.code, code))
      .limit(1)
    return row === undefined ? null : toDefinition(row)
  }

  /** Records a value, refusing anything the declared type does not allow. */
  async set(variantId: string, code: string, value: AttributeValue): Promise<void> {
    const definition = await this.findByCode(code)
    if (definition === null) throw new NotFoundError('attribute definition', code)

    const columns = {
      textValue: null as string | null,
      numberValue: null as number | null,
      booleanValue: null as boolean | null,
      optionValue: null as string | null,
    }

    switch (definition.kind) {
      case 'text':
        if (typeof value !== 'string') throw new CatalogError(`"${code}" expects text`)
        columns.textValue = value
        break
      case 'number':
        if (typeof value !== 'number' || Number.isNaN(value)) {
          throw new CatalogError(`"${code}" expects a number`)
        }
        columns.numberValue = value
        break
      case 'boolean':
        if (typeof value !== 'boolean') throw new CatalogError(`"${code}" expects true or false`)
        columns.booleanValue = value
        break
      case 'option': {
        if (typeof value !== 'string') throw new CatalogError(`"${code}" expects one of its options`)
        const allowed = definition.options ?? []
        if (!allowed.includes(value)) {
          throw new CatalogError(`"${value}" is not an option of "${code}". Allowed: ${allowed.join(', ')}`)
        }
        columns.optionValue = value
        break
      }
    }

    await this.db.transaction(async (tx) => {
      await tx
        .insert(variantAttributes)
        .values({ variantId, definitionId: definition.id, ...columns })
        .onConflictDoUpdate({
          target: [variantAttributes.variantId, variantAttributes.definitionId],
          set: { ...columns, updatedAt: new Date() },
        })
      await recordChange(tx, {
        entityType: 'variant',
        entityId: variantId,
        kind: 'updated',
        changedFields: [`attribute.${code}`],
      })
    })
  }

  async of(variantId: string): Promise<VariantAttribute[]> {
    const rows = await this.db
      .select({ value: variantAttributes, definition: attributeDefinitions })
      .from(variantAttributes)
      .innerJoin(attributeDefinitions, eq(attributeDefinitions.id, variantAttributes.definitionId))
      .where(eq(variantAttributes.variantId, variantId))
      .orderBy(asc(attributeDefinitions.position))

    return rows.flatMap((row) => {
      const kind = row.definition.kind as AttributeKind
      const value =
        kind === 'text'
          ? row.value.textValue
          : kind === 'number'
            ? row.value.numberValue
            : kind === 'boolean'
              ? row.value.booleanValue
              : row.value.optionValue
      if (value === null) return []
      return [{ code: row.definition.code, kind, value, unit: row.definition.unit }]
    })
  }

  /** Variants carrying a given value, which is the point of declaring a type. */
  async variantsWith(code: string, value: AttributeValue): Promise<string[]> {
    const definition = await this.findByCode(code)
    if (definition === null) return []

    const column =
      definition.kind === 'text'
        ? variantAttributes.textValue
        : definition.kind === 'number'
          ? variantAttributes.numberValue
          : definition.kind === 'boolean'
            ? variantAttributes.booleanValue
            : variantAttributes.optionValue

    const rows = await this.db
      .select({ variantId: variantAttributes.variantId })
      .from(variantAttributes)
      .innerJoin(productVariants, eq(productVariants.id, variantAttributes.variantId))
      .where(and(eq(variantAttributes.definitionId, definition.id), eq(column, value)))
    return rows.map((row) => row.variantId)
  }
}

function toDefinition(row: {
  id: string
  code: string
  kind: string
  label: string | null
  unit: string | null
  options: string[] | null
}): AttributeDefinition {
  return {
    id: row.id,
    code: row.code,
    kind: row.kind as AttributeKind,
    label: row.label,
    unit: row.unit,
    options: row.options,
  }
}
