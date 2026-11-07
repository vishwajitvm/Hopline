/** Minimal typed-by-convention event emitter. `on` returns an unsubscribe function. */
export class Emitter {
  #listeners = new Map();

  on(event, listener) {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  emit(event, payload) {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) listener(payload);
  }

  removeAllListeners() {
    this.#listeners.clear();
  }
}
