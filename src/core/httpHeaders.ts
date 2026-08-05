const utf8HeaderPrefix = "utf8:";

export function encodeUtf8HeaderValue(value: string): string {
  return `${utf8HeaderPrefix}${encodeURIComponent(value)}`;
}

export function decodeUtf8HeaderValue(value: string): string {
  if (value.startsWith(utf8HeaderPrefix)) {
    try {
      return decodeURIComponent(value.slice(utf8HeaderPrefix.length));
    } catch {
      return value;
    }
  }

  if (![...value].some((character) => character.charCodeAt(0) > 0x7f)
    || [...value].some((character) => character.charCodeAt(0) > 0xff)) {
    return value;
  }

  const bytes = Uint8Array.from(value, (character) => character.charCodeAt(0));
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const roundTrip = new TextEncoder().encode(decoded);
    if (roundTrip.length === bytes.length && roundTrip.every((byte, index) => byte === bytes[index])) {
      return decoded;
    }
  } catch {
    // A valid Latin-1 value must remain unchanged.
  }
  return value;
}
