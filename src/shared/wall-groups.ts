// Wall groups: the major categories the wall files its services under (docs/design.md, "Wall groups"). They are defined ONCE, in config/watch.example.json
// `wallGroups`, validated by src/server/config.ts `checkWallGroups`, sent to the client in the state (`WallState.wallGroups`) and read here, so the server
// and the wall never keep two lists. A service no group lists falls into "Other", which is always last.

/** One group as the config states it: a stable id, the heading's label, and the service names it holds. The order of the list is the order on the wall. */
export interface WallGroupDef {
  id: string
  label: string
  services: string[]
}

/** The group a service falls into when no group lists it. Reserved: a config group may not use this id or this label. */
export const OTHER_GROUP = { id: 'other', label: 'Other' } as const

/** The section the parked incidents sit in, after every group (src/shared/layout.ts). Reserved: a config group may not use this id or this label. */
export const PARKED_GROUP = { id: 'parked', label: 'Parked' } as const

/**
 * How a service name is compared: case and the separator are ignored, so "Node disk", "node disk" and "node-disk" are one service (an alert that carries no
 * `service` label is named by its origin or by a machine label, which is how a wall tile and its history row can differ in case).
 */
export function serviceKey(name: string): string {
  return name.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ')
}

export interface GroupRef {
  id: string
  label: string
  /** Its place in the wall's order: the position in the config list, and after every configured group for Other. */
  order: number
}

/** The lookup the wall reads: a service name to the group it is filed under (Other when none lists it). Built once per list of groups. */
export function groupLookup(groups: readonly WallGroupDef[] | undefined): (service: string) => GroupRef {
  const byKey = new Map<string, GroupRef>()
  ;(groups ?? []).forEach((g, order) => {
    for (const s of g.services) if (!byKey.has(serviceKey(s))) byKey.set(serviceKey(s), { id: g.id, label: g.label, order })
  })
  const other: GroupRef = { ...OTHER_GROUP, order: (groups ?? []).length }
  return (service) => byKey.get(serviceKey(service)) ?? other
}

/** The groups in the order the wall draws them: the configured ones, then Other. */
export function groupsInOrder(groups: readonly WallGroupDef[] | undefined): GroupRef[] {
  return [...(groups ?? []).map((g, order) => ({ id: g.id, label: g.label, order })), { ...OTHER_GROUP, order: (groups ?? []).length }]
}

/**
 * Check a list of groups. Returns the problems, each one sentence that names what to change; an empty list is a good config. `known`, when given, is the set of
 * service names that exist (the wall's live roster, or what the config itself can produce): an id outside it is a typo, because it would leave a live service
 * in Other and a dead name in a group.
 */
export function wallGroupProblems(groups: unknown, known?: ReadonlySet<string>): string[] {
  if (groups === undefined) return []
  if (!Array.isArray(groups)) return ['wallGroups must be a list of groups']
  const problems: string[] = []
  const ids = new Set<string>()
  const labels = new Set<string>()
  const seen = new Map<string, string>()
  const knownKeys = known ? new Set([...known].map(serviceKey)) : null
  groups.forEach((g: unknown, n) => {
    const where = `wallGroups[${n}]`
    if (typeof g !== 'object' || g === null || Array.isArray(g)) {
      problems.push(`${where} must be an object with id, label and services`)
      return
    }
    const { id, label, services } = g as Partial<WallGroupDef>
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id)) problems.push(`${where} needs an id of lower case letters, digits and dashes`)
    else if (id === OTHER_GROUP.id) problems.push(`${where}: the id "${OTHER_GROUP.id}" is reserved for the services no group lists, which Watch adds last`)
    else if (id === PARKED_GROUP.id) problems.push(`${where}: the id "${PARKED_GROUP.id}" is reserved for the section of parked incidents, which Watch adds after the groups`)
    else if (ids.has(id)) problems.push(`${where}: duplicate group id ${id}`)
    else ids.add(id)
    const name = typeof id === 'string' ? id : where
    if (typeof label !== 'string' || label.trim() === '' || label.length > 40 || /[\r\n]/.test(label)) problems.push(`${where} (${name}) needs a label of one line, at most 40 characters`)
    else if (label.trim().toLowerCase() === OTHER_GROUP.label.toLowerCase()) problems.push(`${where} (${name}): the label "${OTHER_GROUP.label}" is reserved for the services no group lists`)
    else if (label.trim().toLowerCase() === PARKED_GROUP.label.toLowerCase()) problems.push(`${where} (${name}): the label "${PARKED_GROUP.label}" is reserved for the section of parked incidents`)
    else if (labels.has(label.trim().toLowerCase())) problems.push(`${where} (${name}): duplicate label ${label}`)
    else labels.add(label.trim().toLowerCase())
    if (!Array.isArray(services) || services.length === 0) {
      problems.push(`${where} (${name}) needs services, a list of at least one service name`)
      return
    }
    for (const s of services) {
      if (typeof s !== 'string' || s.trim() === '') {
        problems.push(`${where} (${name}) lists a service with no name`)
        continue
      }
      const key = serviceKey(s)
      const held = seen.get(key)
      if (held !== undefined) problems.push(`service "${s}" is in two places: ${held} and ${name}; a service belongs to one group`)
      else seen.set(key, name)
      if (knownKeys && !knownKeys.has(key)) problems.push(`${where} (${name}) lists "${s}", which is not a service the wall has`)
    }
  })
  return problems
}
