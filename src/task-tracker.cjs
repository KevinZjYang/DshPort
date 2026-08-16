// Task-completion tracker for the desktop shell.
//
// Polls the harness session list and watches the `running` flag of each
// top-level session. A transition from running to idle means the agent task
// ended (completed, or cancelled by the user) — the shell turns that into a
// Windows notification.
//
// Pure logic, no Electron imports: unit-testable with `node --test`.

const { basename, sep } = require('node:path')

/** Extract a human-friendly title from one session.list row. */
function sessionTitleOf(item) {
  const projected = item?.projections?.values?.title
  if (typeof projected === 'string' && projected.trim() !== '') return projected.trim()
  if (typeof item?.cwd === 'string' && item.cwd.trim() !== '') {
    const leaf = basename(item.cwd.replaceAll('/', sep))
    if (leaf !== '') return leaf
  }
  return item?.sessionId ?? ''
}

/**
 * @param {Record<string, unknown>} item - one session.list row.
 * @returns {boolean} whether this row is a top-level, non-blank session.
 */
function isNotifiableSession(item) {
  if (item?.blank === true) return false
  // Subagent sessions complete constantly; notifying for each would spam.
  if (item?.parentSessionId !== undefined) return false
  return typeof item?.sessionId === 'string' && item.sessionId !== ''
}

/**
 * Create a completion tracker. The first observation of a session is a
 * baseline — never a completion — so sessions already finished before the
 * shell started watching are not reported.
 * @returns {{ ingest(items: unknown[]): Array<{ sessionId: string, title: string }> }}
 */
function createTaskTracker() {
  /** @type {Map<string, { running: boolean, title: string }>} */
  const known = new Map()

  return {
    ingest(items) {
      const completed = []
      for (const item of Array.isArray(items) ? items : []) {
        if (!isNotifiableSession(item)) continue
        const sessionId = item.sessionId
        const running = item.running === true
        const title = sessionTitleOf(item)
        const previous = known.get(sessionId)
        if (previous === undefined) {
          known.set(sessionId, { running, title })
          continue
        }
        if (previous.running && !running) {
          completed.push({ sessionId, title: title || previous.title })
        }
        known.set(sessionId, { running, title })
      }
      return completed
    },
  }
}

module.exports = { createTaskTracker, sessionTitleOf }
