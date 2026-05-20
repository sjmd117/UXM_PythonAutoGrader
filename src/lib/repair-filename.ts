const HANGUL_PATTERN = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]/gu;
const REPLACEMENT_PATTERN = /\uFFFD/gu;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu;
const LATIN1_MOJIBAKE_HINT_PATTERN = /[\u0080-\u009f\u00a1-\u00ff]/gu;

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function bytesFromLatin1LikeText(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function decodeBytes(bytes: Uint8Array, encoding: string): string | null {
  try {
    return new TextDecoder(encoding).decode(bytes).normalize("NFC");
  } catch {
    return null;
  }
}

function filenameScore(value: string): number {
  const hangulCount = countMatches(value, HANGUL_PATTERN);
  const replacementCount = countMatches(value, REPLACEMENT_PATTERN);
  const controlCount = countMatches(value, CONTROL_PATTERN);
  const mojibakeHintCount = countMatches(value, LATIN1_MOJIBAKE_HINT_PATTERN);

  return hangulCount * 8 - replacementCount * 30 - controlCount * 30 - mojibakeHintCount;
}

export function repairFilenameMojibake(value: string): string {
  const normalized = value.normalize("NFC");
  const bytes = bytesFromLatin1LikeText(value);
  const candidates = [
    normalized,
    decodeBytes(bytes, "utf-8"),
    decodeBytes(bytes, "euc-kr"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.reduce((best, candidate) => {
    if (filenameScore(candidate) > filenameScore(best)) {
      return candidate;
    }
    return best;
  }, normalized);
}
