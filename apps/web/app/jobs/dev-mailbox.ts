export type MailMessage = {
  id: string
  to: string
  subject: string
  payload: Record<string, unknown>
  sentAt: string
}

class DevMailbox {
  private messages: MailMessage[] = []

  send(message: { to: string; subject: string; payload: Record<string, unknown> }): MailMessage {
    let msg: MailMessage = {
      id: crypto.randomUUID(),
      to: message.to,
      subject: message.subject,
      payload: message.payload,
      sentAt: new Date().toISOString(),
    }
    this.messages.push(msg)
    return msg
  }

  getMessages(): MailMessage[] {
    return [...this.messages]
  }

  findInvite(email: string): MailMessage | undefined {
    return this.messages.findLast(
      (m) =>
        m.to.toLowerCase() === email.toLowerCase() &&
        (m.payload.inviteUrl !== undefined || m.subject.toLowerCase().includes('invitation')),
    )
  }

  findPasswordReset(email: string): MailMessage | undefined {
    return this.messages.findLast(
      (m) =>
        m.to.toLowerCase() === email.toLowerCase() &&
        (m.payload.resetUrl !== undefined || m.subject.toLowerCase().includes('reset')),
    )
  }

  clear(): void {
    this.messages = []
  }
}

export const devMailbox = new DevMailbox()
