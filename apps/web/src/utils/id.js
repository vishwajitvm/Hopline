/** Random 64-bit hex id. Uses getRandomValues, which (unlike randomUUID) also works on plain-HTTP LAN addresses. */
export function createId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
