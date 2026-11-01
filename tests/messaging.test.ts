import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { createMemoryRepository, type Repository } from '../src/store.js'

describe('message read state and muted notifications', () => {
  let repository: Repository
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    repository = createMemoryRepository()
    app = createApp(repository)
  })

  async function login(accountId: string) {
    const agent = request.agent(app)
    const signedIn = await agent.post('/api/auth/sign-in').send({ emailOrId: accountId, password: 'Accs@Qcu2026!' })

    expect(signedIn.status).toBe(200)
    return agent
  }

  it('STU-03-V tracks unread messages, marks threads read, and respects mute preferences', async () => {
    const student = await login('QCU-STU-IT-A')
    const professor = await login('QCU-PROF-IT')
    const inbox = await student.get('/api/pages/P11')
    const initialThread = inbox.body.data.threads.find(
      (thread: { id: string }) => thread.id === 'THREAD-IT-A',
    )

    expect(initialThread.unread).toBe(1)

    const read = await student.post('/api/pages/P12/actions').send({
      action: 'markThreadRead',
      recordId: 'THREAD-IT-A',
      payload: {},
    })

    expect(read.status).toBe(200)
    expect((await student.get('/api/pages/P11')).body.data.threads.find(
      (thread: { id: string }) => thread.id === 'THREAD-IT-A',
    ).unread).toBe(0)

    const muted = await student.post('/api/pages/P12/actions').send({
      action: 'muteThread',
      recordId: 'THREAD-IT-A',
      payload: { muted: true },
    })

    expect(muted.status).toBe(200)

    const noticesBefore = repository.read().notifications.filter(
      notification => notification.recipientId === 'QCU-STU-IT-A'
        && notification.kind === 'message',
    ).length
    const sent = await professor.post('/api/pages/P12/actions').send({
      action: 'sendMessage',
      recordId: 'THREAD-IT-A',
      payload: { body: 'The updated lab schedule is available in class.' },
    })

    expect(sent.status).toBe(200)
    expect(repository.read().notifications.filter(
      notification => notification.recipientId === 'QCU-STU-IT-A'
        && notification.kind === 'message',
    )).toHaveLength(noticesBefore)
    expect((await student.get('/api/pages/P11')).body.data.threads.find(
      (thread: { id: string }) => thread.id === 'THREAD-IT-A',
    ).unread).toBe(1)
  })

  it('STU-03-I denies read-state changes for a conversation outside the user scope', async () => {
    const student = await login('QCU-STU-IT-B')
    const response = await student.post('/api/pages/P12/actions').send({
      action: 'markThreadRead',
      recordId: 'THREAD-IT-A',
      payload: {},
    })

    expect(response.status).toBe(404)
  })
})
