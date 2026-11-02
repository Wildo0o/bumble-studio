// SSE（Server-Sent Events）解码器。
//
// 设计取舍：用显式的状态机对象 + 批量 push/flush，而不是生成器内联闭包。
// 好处是解码逻辑可以脱离流单独测试（喂字符串片段即可），也便于将来
// 接 WebSocket 或本地 IPC 通道时复用同一套解析。
//
// 只实现本项目用得到的字段（data / event / id）。retry 字段不处理，
// 因为我们不做自动重连——重连语义属于 Run 层，不属于传输层。

export interface SSEEvent {
  /** event: 字段。多数服务商不使用。 */
  event?: string
  /** data: 字段，多行会用 \n 拼接。 */
  data: string
  /** id: 字段，用于断点续传；本项目只透传不消费。 */
  id?: string
}

const COLON = 0x3a
const SPACE = 0x20
const CR = 0x0d
const LF = 0x0a

export class SSEDecoder {
  private pending = ''
  private dataLines: string[] = []
  private eventName: string | undefined
  private lastId: string | undefined

  /** 喂入一段文本，返回其中已经完整的事件。不完整的部分留到下次。 */
  push(chunk: string): SSEEvent[] {
    this.pending += chunk
    const out: SSEEvent[] = []
    let cursor = 0

    for (;;) {
      const nl = this.findLineBreak(cursor)
      if (nl === -1) break

      const line = this.pending.slice(cursor, nl)
      // \r\n 要整体消费，否则会多出一个空行
      let next = nl + 1
      if (this.pending.charCodeAt(nl) === CR && this.pending.charCodeAt(next) === LF) next++

      cursor = next
      const ev = this.consumeLine(line)
      if (ev) out.push(ev)
    }

    this.pending = this.pending.slice(cursor)
    return out
  }

  /** 流结束时调用：处理残留的行缓冲，并吐出最后一个未闭合的事件。 */
  flush(): SSEEvent[] {
    const out: SSEEvent[] = []
    if (this.pending.length > 0) {
      const line = this.pending.endsWith('\r') ? this.pending.slice(0, -1) : this.pending
      this.pending = ''
      const ev = this.consumeLine(line)
      if (ev) out.push(ev)
    }
    const tail = this.emit()
    if (tail) out.push(tail)
    return out
  }

  private findLineBreak(from: number): number {
    for (let i = from; i < this.pending.length; i++) {
      const c = this.pending.charCodeAt(i)
      if (c === LF || c === CR) return i
    }
    return -1
  }

  private consumeLine(line: string): SSEEvent | null {
    // 空行 = 一个事件结束
    if (line.length === 0) return this.emit()

    // ':' 开头是注释（心跳常用），忽略
    if (line.charCodeAt(0) === COLON) return null

    const sep = line.indexOf(':')
    const field = sep === -1 ? line : line.slice(0, sep)
    let value = sep === -1 ? '' : line.slice(sep + 1)
    // 规范允许冒号后有一个空格，要去掉；多余的空格是内容的一部分
    if (value.charCodeAt(0) === SPACE) value = value.slice(1)

    if (field === 'data') this.dataLines.push(value)
    else if (field === 'event') this.eventName = value
    else if (field === 'id') this.lastId = value

    return null
  }

  private emit(): SSEEvent | null {
    if (this.dataLines.length === 0) {
      // 只有 event 没有 data 的事件按规范应当忽略
      this.eventName = undefined
      return null
    }
    const ev: SSEEvent = { data: this.dataLines.join('\n') }
    if (this.eventName !== undefined) ev.event = this.eventName
    if (this.lastId !== undefined) ev.id = this.lastId
    this.dataLines = []
    this.eventName = undefined
    return ev
  }
}

/** 把 fetch 的 ReadableStream 解码成事件流。 */
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const decoder = new SSEDecoder()
  const reader = body.getReader()
  const text = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // stream: true 让跨 chunk 的多字节字符不会被截断成乱码
      const piece = text.decode(value, { stream: true })
      if (piece) for (const ev of decoder.push(piece)) yield ev
    }
    const tail = text.decode()
    if (tail) for (const ev of decoder.push(tail)) yield ev
    for (const ev of decoder.flush()) yield ev
  } finally {
    reader.releaseLock()
  }
}
