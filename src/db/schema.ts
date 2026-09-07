/**
 * Every table in a tenant database. Modules own their own tables and this file
 * only collects them, so the shape of the database is always readable in one
 * place without any module reaching into another's schema.
 */

export * from '../auth/schema.js'
export * from '../catalog/schema.js'
export * from '../catalog-import/schema.js'
export * from '../change-feed/schema.js'
export * from '../channels/schema.js'
export * from '../pricing/schema.js'
export * from '../tenancy/schema.js'
