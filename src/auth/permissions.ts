/**
 * Permissions name operations, not screens.
 *
 * A permission attached to a screen is enforced by whichever client bothers to
 * check it; a permission attached to an operation is enforced once, on the
 * server, and applies equally to the admin interface, an integration and a bot.
 */
export const PERMISSIONS = [
  // People and access
  'staff.read',
  'staff.manage',
  'audit.read',

  // Tenant configuration and integration credentials
  'settings.read',
  'settings.manage',

  // The journal and its consumers
  'feed.read',
  'feed.manage',

  // Sales channels
  'channel.read',
  'channel.manage',

  // Catalog
  'catalog.read',
  'catalog.write',
  'price.read',
  'price.write',

  // Stock
  'inventory.read',
  'inventory.write',

  // Money. `cost.read` gates purchase prices and margins; `ledger.post`
  // gates writing to the books.
  'cost.read',
  'ledger.read',
  'ledger.post',

  // Documents
  'document.read',
  'document.write',
  'document.confirm',
  'document.cancel',

  // Reporting
  'report.read',
  'report.export',
] as const

export type Permission = (typeof PERMISSIONS)[number]

const ALL: readonly Permission[] = PERMISSIONS

/** Roles shipped with the product. A tenant may add its own on top. */
export const SYSTEM_ROLES = {
  owner: ALL,
  manager: [
    'staff.read',
    'settings.read',
    'feed.read',
    'channel.read',
    'channel.manage',
    'catalog.read',
    'catalog.write',
    'price.read',
    'price.write',
    'inventory.read',
    'ledger.read',
    'document.read',
    'document.write',
    'document.confirm',
    'document.cancel',
    'report.read',
    'report.export',
  ],
  warehouse: [
    'catalog.read',
    'inventory.read',
    'inventory.write',
    'document.read',
    'document.write',
    'document.confirm',
  ],
  accountant: [
    'settings.read',
    'catalog.read',
    'price.read',
    'inventory.read',
    'cost.read',
    'ledger.read',
    'ledger.post',
    'document.read',
    'report.read',
    'report.export',
    'audit.read',
  ],
  viewer: ['catalog.read', 'inventory.read', 'document.read', 'report.read'],
} as const satisfies Record<string, readonly Permission[]>

export type SystemRole = keyof typeof SYSTEM_ROLES

export const SYSTEM_ROLE_NAMES = Object.keys(SYSTEM_ROLES) as readonly SystemRole[]

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value)
}

export function isSystemRole(value: string): value is SystemRole {
  return value in SYSTEM_ROLES
}

/**
 * Permissions that must never reach an actor without an explicit grant, even
 * as a field in a larger response.
 */
export const SENSITIVE_PERMISSIONS: readonly Permission[] = ['cost.read', 'ledger.read']
