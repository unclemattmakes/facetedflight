export interface FreeFlightRow {
  readonly id: string
  readonly source: string
  readonly title: string
}
export const FREE_FLIGHT_SOURCES: readonly FreeFlightRow[]
export const freeFlightCourse: (
  source: Record<string, unknown>,
  row: FreeFlightRow,
) => Record<string, unknown>
export const serialise: (course: Record<string, unknown>) => string
export const REPO_ROOT: string
