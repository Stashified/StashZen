/**
 * Read a response body, refusing to buffer past a byte cap.
 *
 * Counting bytes as they arrive means an oversized or never-ending response is
 * cut off instead of being held in memory first; `text()` would buffer all of
 * it. `tooLarge` builds the caller's own error, since the wording and code
 * belong to the endpoint that set the cap.
 */
export async function readCappedText(res, maxBytes, tooLarge) {
  if (!res.body?.getReader) {
    // Fallback without streams, i.e. engines older than this app's floor. The
    // whole body is buffered here and a never-ending response is bounded only
    // by the network; encode before comparing, or a non-ASCII body can pass a
    // UTF-16 code-unit count while exceeding the byte budget.
    const body = await res.text();
    if (new TextEncoder().encode(body).byteLength > maxBytes) throw tooLarge();
    return body;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw tooLarge();
    }
    chunks.push(value);
  }

  // Bytes first, then one decode: a multi-byte character split across chunks
  // must not be decoded piecemeal.
  const bytes = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(bytes);
}
