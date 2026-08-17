import test from 'node:test'
import assert from 'node:assert/strict'
import { frameNotification, frameResolution } from '../src/interaction-frames.cjs'

function envelope(payload, rpcId = 'rpc-1') {
  return { type: 'server-request', rpcId, method: payload.type, payload }
}

test('approval/requested yields a notification with tool name and reason', () => {
  const result = frameNotification(envelope({
    type: 'approval/requested',
    sessionId: 's1',
    approvalId: 'a1',
    toolName: 'bash',
    reason: '需要执行构建命令',
  }))
  assert.deepEqual(result, {
    key: 'approval:a1',
    title: '需要你授权',
    body: 'AI 请求执行 bash（需要执行构建命令）',
  })
})

test('approval/requested without reason omits the parens', () => {
  const result = frameNotification(envelope({
    type: 'approval/requested',
    sessionId: 's1',
    approvalId: 'a2',
    toolName: 'fs_write',
  }))
  assert.equal(result.body, 'AI 请求执行 fs_write')
})

test('question/requested yields a notification with options joined', () => {
  const result = frameNotification(envelope({
    type: 'question/requested',
    sessionId: 's1',
    questions: [{
      id: 'q1',
      question: '继续执行吗？',
      options: [{ label: '继续' }, { label: '停止' }],
    }],
  }, 'rpc-q1'))
  assert.deepEqual(result, {
    key: 'question:rpc-q1',
    title: 'AI 在等你回答',
    body: '继续执行吗？\n继续 / 停止',
  })
})

test('question/requested without options keeps plain question text', () => {
  const result = frameNotification(envelope({
    type: 'question/requested',
    sessionId: 's1',
    questions: [{ id: 'q2', question: '请输入目录路径' }],
  }, 'rpc-q2'))
  assert.equal(result.body, '请输入目录路径')
  assert.equal(result.key, 'question:rpc-q2')
})

test('empty or blank question is ignored', () => {
  assert.equal(frameNotification(envelope({
    type: 'question/requested',
    sessionId: 's1',
    questions: [{ id: 'q3', question: '   ' }],
  })), null)
})

test('unrelated frames yield no notification', () => {
  for (const type of ['session/event', 'session/subscribed', 'session/jobs', 'stream/error', 'host/session-status']) {
    assert.equal(frameNotification(envelope({ type, sessionId: 's1' })), null, type)
  }
})

test('approval/resolved yields the matching key', () => {
  assert.deepEqual(frameResolution(envelope({
    type: 'approval/resolved',
    sessionId: 's1',
    approvalId: 'a1',
    outcome: 'allowed-once',
  })), { key: 'approval:a1' })
})

test('question/resolved yields the matching key from questionRpcId', () => {
  assert.deepEqual(frameResolution(envelope({
    type: 'question/resolved',
    sessionId: 's1',
    questionRpcId: 'rpc-q1',
    outcome: 'answered',
  })), { key: 'question:rpc-q1' })
})

test('unrelated frames yield no resolution', () => {
  for (const type of ['session/event', 'question/requested', 'approval/requested']) {
    assert.equal(frameResolution(envelope({ type, sessionId: 's1' })), null, type)
  }
})

test('malformed payloads are ignored defensively', () => {
  assert.equal(frameNotification({ type: 'server-request', rpcId: 'x', method: 'y' }), null)
  assert.equal(frameNotification(null), null)
  assert.equal(frameResolution({ type: 'server-request', rpcId: 'x', method: 'y', payload: 'nope' }), null)
})
