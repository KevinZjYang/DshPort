import test from 'node:test'
import assert from 'node:assert/strict'
import { createTaskTracker, sessionTitleOf } from '../src/task-tracker.cjs'

function session(overrides = {}) {
  return {
    sessionId: 'sess-1',
    updatedAt: 1000,
    running: false,
    blank: false,
    ...overrides,
  }
}

test('empty list yields no completions', () => {
  const tracker = createTaskTracker()
  assert.deepEqual(tracker.ingest([]), [])
})

test('running session that stops yields a completion', () => {
  const tracker = createTaskTracker()
  assert.deepEqual(tracker.ingest([session({ running: true })]), [])
  const completed = tracker.ingest([session({ running: false })])
  assert.equal(completed.length, 1)
  assert.equal(completed[0].sessionId, 'sess-1')
  assert.equal(completed[0].title, 'sess-1')
})

test('session already idle on first sight is only a baseline', () => {
  const tracker = createTaskTracker()
  assert.deepEqual(tracker.ingest([session({ running: false })]), [])
  assert.deepEqual(tracker.ingest([session({ running: false })]), [])
})

test('blank sessions are ignored', () => {
  const tracker = createTaskTracker()
  assert.deepEqual(tracker.ingest([session({ running: true, blank: true })]), [])
  assert.deepEqual(tracker.ingest([session({ running: false, blank: true })]), [])
})

test('subagent sessions (parentSessionId) are ignored', () => {
  const tracker = createTaskTracker()
  const item = session({ running: true, parentSessionId: 'parent-1' })
  assert.deepEqual(tracker.ingest([item]), [])
  assert.deepEqual(tracker.ingest([{ ...item, running: false }]), [])
})

test('repeated running cycles notify once per completion', () => {
  const tracker = createTaskTracker()
  assert.deepEqual(tracker.ingest([session({ running: true })]), [])
  assert.equal(tracker.ingest([session({ running: false })]).length, 1)
  assert.deepEqual(tracker.ingest([session({ running: true })]), [])
  assert.equal(tracker.ingest([session({ running: false })]).length, 1)
})

test('title comes from projections, then cwd leaf, then sessionId', () => {
  assert.equal(sessionTitleOf({ sessionId: 's', projections: { values: { title: '  修复测试  ' } } }), '修复测试')
  assert.equal(sessionTitleOf({ sessionId: 's', cwd: 'C:\\work\\my-project' }), 'my-project')
  assert.equal(sessionTitleOf({ sessionId: 's', cwd: 'C:\\work\\' }), 'work')
  assert.equal(sessionTitleOf({ sessionId: 's', cwd: 'C:\\' }), 's')
  assert.equal(sessionTitleOf({ sessionId: 's' }), 's')
})

test('completion uses the freshest title when the old one was blank', () => {
  const tracker = createTaskTracker()
  assert.deepEqual(tracker.ingest([session({ running: true, cwd: 'C:\\work\\proj' })]), [])
  const completed = tracker.ingest([session({ running: false, projections: { values: { title: '新标题' } } })])
  assert.equal(completed.length, 1)
  assert.equal(completed[0].title, '新标题')
})
