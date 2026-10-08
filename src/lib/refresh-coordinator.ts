/** Share pending reads; an event received during a read requests one follow-up. */
export class RefreshCoordinator {
  private pending = new Map<string, { promise: Promise<void>; again: boolean }>()

  run(key: string, read: () => Promise<void>, afterCurrent = false): Promise<void> {
    const existing = this.pending.get(key)
    if (existing) {
      existing.again ||= afterCurrent
      return existing.promise
    }
    const entry = { promise: Promise.resolve(), again: false }
    this.pending.set(key, entry)
    entry.promise = Promise.resolve().then(async () => {
      await read()
      if (entry.again) { entry.again = false; await read() }
    }).finally(() => {
      if (this.pending.get(key) === entry) this.pending.delete(key)
    })
    return entry.promise
  }
}
