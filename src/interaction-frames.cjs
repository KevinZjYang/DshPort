// Mux event-stream frame parsing for the desktop shell.
//
// The harness pushes a real-time event stream over
// ws://127.0.0.1:<port>/api/events.mux. Each message is a server-request
// envelope { type: 'server-request', rpcId, method, payload }. The payloads we
// care about announce that the AI is waiting on the user (tool approval or an
// ask_user_question) and when the user answered, so the shell can raise a
// "waiting for you" Windows notification and dismiss it on resolution.
//
// Pure logic, no Electron imports: unit-testable with `node --test`.

/**
 * Extract the notification content from one mux envelope, or null when the
 * frame does not ask for user interaction.
 * @param {unknown} envelope - parsed server-request envelope.
 * @returns {{ key: string, title: string, body: string } | null}
 */
function frameNotification(envelope) {
  const payload = envelope?.payload
  if (payload === null || typeof payload !== 'object') return null
  switch (payload.type) {
    case 'approval/requested': {
      const toolName = typeof payload.toolName === 'string' ? payload.toolName : '工具'
      const reason = typeof payload.reason === 'string' && payload.reason.trim() !== ''
        ? `（${payload.reason.trim()}）`
        : ''
      return {
        key: `approval:${payload.approvalId}`,
        title: '需要你授权',
        body: `AI 请求执行 ${toolName}${reason}`,
      }
    }
    case 'question/requested': {
      const first = Array.isArray(payload.questions) ? payload.questions[0] : undefined
      if (first === undefined || typeof first.question !== 'string' || first.question.trim() === '') return null
      const question = first.question.trim()
      const options = Array.isArray(first.options) && first.options.length > 0
        ? first.options.map(option => (option && typeof option.label === 'string') ? option.label : '').filter(Boolean).join(' / ')
        : ''
      return {
        key: `question:${envelope?.rpcId}`,
        title: 'AI 在等你回答',
        body: options === '' ? question : `${question}\n${options}`,
      }
    }
    default:
      return null
  }
}

/**
 * Extract the resolution key from one mux envelope, or null when the frame
 * does not resolve a previous interaction.
 * @param {unknown} envelope - parsed server-request envelope.
 * @returns {{ key: string } | null}
 */
function frameResolution(envelope) {
  const payload = envelope?.payload
  if (payload === null || typeof payload !== 'object') return null
  switch (payload.type) {
    case 'approval/resolved':
      return { key: `approval:${payload.approvalId}` }
    case 'question/resolved':
      return { key: `question:${payload.questionRpcId}` }
    default:
      return null
  }
}

module.exports = { frameNotification, frameResolution }
