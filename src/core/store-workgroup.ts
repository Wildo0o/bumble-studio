// 工作组的持久化。
//
// 三张表：role / work_package / change_set。
//
// 所有状态迁移都走**条件更新**（CAS），没有一处是「读出来判断再写」：
//   UPDATE ... WHERE id = ? AND status IN (...)
// 返回 changes 为 0 就说明状态已被别人改动。
// 这是「两个总控同时派活」时唯一正确的做法——先读后写必然双写成功。
import type Database from 'better-sqlite3'
import type {
  ChangeSet,
  FileChange,
  RoleDefinition,
  WorkPackage,
  WorkPackageKind,
  WorkPackageStatus,
} from './workgroup.js'
import type { WorkgroupPersistence } from './workgroup-coordinator.js'

const PACKAGE_COLUMNS =
  'id, task_id as taskId, role_id as roleId, kind, title, deliverable, status, ' +
  'depends_on as dependsOn, created_at as createdAt, started_at as startedAt, ended_at as endedAt'

const CHANGESET_COLUMNS =
  'id, task_id as taskId, work_package_id as workPackageId, role_id as roleId, run_id as runId, ' +
  'changes, status, created_at as createdAt, merged_at as mergedAt'

const ROLE_COLUMNS =
  'id, name, responsibility, allowed_tools as allowedTools, produces'

interface PackageRow {
  id: string
  taskId: string
  roleId: string | null
  kind: string
  title: string
  deliverable: string
  status: string
  dependsOn: string
  createdAt: number
  startedAt: number | null
  endedAt: number | null
}

interface ChangeSetRow {
  id: string
  taskId: string
  workPackageId: string
  roleId: string
  runId: string | null
  changes: string
  status: string
  createdAt: number
  mergedAt: number | null
}

interface RoleRow {
  id: string
  name: string
  responsibility: string
  allowedTools: string
  produces: string
}

function mapPackage(r: PackageRow): WorkPackage {
  const pkg: WorkPackage = {
    id: r.id,
    taskId: r.taskId,
    kind: r.kind as WorkPackageKind,
    title: r.title,
    deliverable: r.deliverable,
    status: r.status as WorkPackageStatus,
    dependsOn: JSON.parse(r.dependsOn) as string[],
    createdAt: r.createdAt,
  }
  if (r.roleId) pkg.roleId = r.roleId
  if (r.startedAt !== null) pkg.startedAt = r.startedAt
  if (r.endedAt !== null) pkg.endedAt = r.endedAt
  return pkg
}

function mapChangeSet(r: ChangeSetRow): ChangeSet {
  const cs: ChangeSet = {
    id: r.id,
    taskId: r.taskId,
    workPackageId: r.workPackageId,
    roleId: r.roleId,
    changes: JSON.parse(r.changes) as FileChange[],
    status: r.status as ChangeSet['status'],
    createdAt: r.createdAt,
  }
  if (r.runId) cs.runId = r.runId
  if (r.mergedAt !== null) cs.mergedAt = r.mergedAt
  return cs
}

function mapRole(r: RoleRow): RoleDefinition {
  return {
    id: r.id,
    name: r.name,
    responsibility: r.responsibility,
    allowedTools: JSON.parse(r.allowedTools) as string[],
    produces: JSON.parse(r.produces) as WorkPackageKind[],
  }
}

/** Store 上需要暴露的工作组接口。 */
export interface WorkgroupStoreApi {
  upsertRole(role: RoleDefinition): void
  getRole(id: string): RoleDefinition | undefined
  listRoles(): RoleDefinition[]

  listPackages(taskId: string): WorkPackage[]
  getPackage(id: string): WorkPackage | undefined
  insertPackage(pkg: WorkPackage): void
  casPackage(
    id: string,
    expectedFrom: WorkPackageStatus[],
    next: WorkPackageStatus,
    patch?: Partial<Pick<WorkPackage, 'roleId' | 'startedAt' | 'endedAt'>>,
  ): boolean

  insertChangeSet(cs: ChangeSet): void
  listChangeSets(taskId: string): ChangeSet[]
  getChangeSet(id: string): ChangeSet | undefined
  casChangeSet(
    id: string,
    expectedFrom: ChangeSet['status'],
    next: ChangeSet['status'],
    mergedAt?: number,
  ): boolean
}

export function installWorkgroupStore(
  proto: Record<string, unknown>,
  makeId: () => string,
): void {
  const dbOf = (self: unknown): Database.Database => (self as { db: Database.Database }).db

  proto.upsertRole = function (this: unknown, role: RoleDefinition): void {
    dbOf(this)
      .prepare(
        `INSERT INTO role(id, name, responsibility, allowed_tools, produces)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           responsibility = excluded.responsibility,
           allowed_tools = excluded.allowed_tools,
           produces = excluded.produces`,
      )
      .run(
        role.id,
        role.name,
        role.responsibility,
        JSON.stringify(role.allowedTools),
        JSON.stringify(role.produces),
      )
  }

  proto.getRole = function (this: unknown, id: string): RoleDefinition | undefined {
    const row = dbOf(this)
      .prepare(`SELECT ${ROLE_COLUMNS} FROM role WHERE id = ?`)
      .get(id) as RoleRow | undefined
    return row ? mapRole(row) : undefined
  }

  proto.listRoles = function (this: unknown): RoleDefinition[] {
    const rows = dbOf(this)
      .prepare(`SELECT ${ROLE_COLUMNS} FROM role ORDER BY id ASC`)
      .all() as RoleRow[]
    return rows.map(mapRole)
  }

  proto.listPackages = function (this: unknown, taskId: string): WorkPackage[] {
    const rows = dbOf(this)
      .prepare(`SELECT ${PACKAGE_COLUMNS} FROM work_package WHERE task_id = ? ORDER BY created_at ASC`)
      .all(taskId) as PackageRow[]
    return rows.map(mapPackage)
  }

  proto.getPackage = function (this: unknown, id: string): WorkPackage | undefined {
    const row = dbOf(this)
      .prepare(`SELECT ${PACKAGE_COLUMNS} FROM work_package WHERE id = ?`)
      .get(id) as PackageRow | undefined
    return row ? mapPackage(row) : undefined
  }

  proto.insertPackage = function (this: unknown, pkg: WorkPackage): void {
    dbOf(this)
      .prepare(
        `INSERT INTO work_package(id, task_id, role_id, kind, title, deliverable, status, depends_on, created_at, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pkg.id,
        pkg.taskId,
        pkg.roleId ?? null,
        pkg.kind,
        pkg.title,
        pkg.deliverable,
        pkg.status,
        JSON.stringify(pkg.dependsOn),
        pkg.createdAt,
        pkg.startedAt ?? null,
        pkg.endedAt ?? null,
      )
  }

  proto.casPackage = function (
    this: unknown,
    id: string,
    expectedFrom: WorkPackageStatus[],
    next: WorkPackageStatus,
    patch: Partial<Pick<WorkPackage, 'roleId' | 'startedAt' | 'endedAt'>> = {},
  ): boolean {
    if (expectedFrom.length === 0) return false
    const db = dbOf(this)
    const placeholders = expectedFrom.map(() => '?').join(', ')

    // 动态拼 SET 子句：只更新调用方显式给出的字段，
    // 否则「开始包」会把 startedAt 覆盖成 null。
    const sets: string[] = ['status = ?']
    const params: unknown[] = [next]
    if (patch.roleId !== undefined) {
      sets.push('role_id = ?')
      params.push(patch.roleId)
    }
    if (patch.startedAt !== undefined) {
      sets.push('started_at = ?')
      params.push(patch.startedAt)
    }
    if (patch.endedAt !== undefined) {
      sets.push('ended_at = ?')
      params.push(patch.endedAt)
    }

    params.push(id, ...expectedFrom)
    const res = db
      .prepare(`UPDATE work_package SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders})`)
      .run(...params)
    return res.changes > 0
  }

  proto.insertChangeSet = function (this: unknown, cs: ChangeSet): void {
    dbOf(this)
      .prepare(
        `INSERT INTO change_set(id, task_id, work_package_id, role_id, run_id, changes, status, created_at, merged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cs.id,
        cs.taskId,
        cs.workPackageId,
        cs.roleId,
        cs.runId ?? null,
        JSON.stringify(cs.changes),
        cs.status,
        cs.createdAt,
        cs.mergedAt ?? null,
      )
  }

  proto.listChangeSets = function (this: unknown, taskId: string): ChangeSet[] {
    const rows = dbOf(this)
      .prepare(`SELECT ${CHANGESET_COLUMNS} FROM change_set WHERE task_id = ? ORDER BY created_at ASC`)
      .all(taskId) as ChangeSetRow[]
    return rows.map(mapChangeSet)
  }

  proto.getChangeSet = function (this: unknown, id: string): ChangeSet | undefined {
    const row = dbOf(this)
      .prepare(`SELECT ${CHANGESET_COLUMNS} FROM change_set WHERE id = ?`)
      .get(id) as ChangeSetRow | undefined
    return row ? mapChangeSet(row) : undefined
  }

  proto.casChangeSet = function (
    this: unknown,
    id: string,
    expectedFrom: ChangeSet['status'],
    next: ChangeSet['status'],
    mergedAt?: number,
  ): boolean {
    const db = dbOf(this)
    const res = mergedAt === undefined
      ? db
          .prepare('UPDATE change_set SET status = ? WHERE id = ? AND status = ?')
          .run(next, id, expectedFrom)
      : db
          .prepare('UPDATE change_set SET status = ?, merged_at = ? WHERE id = ? AND status = ?')
          .run(next, mergedAt, id, expectedFrom)
    return res.changes > 0
  }

  // 保留 makeId 供将来需要生成内部 id 的扩展使用（当前由调用方提供 id）。
  void makeId
}

export type { WorkgroupPersistence }
