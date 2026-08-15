export function redactSensitiveUrls(value: string): string {
  return value.replace(/https?:\/\/[^\s]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      const hadCredentials = Boolean(url.username || url.password);
      const hadQuery = Boolean(url.search);
      const credentialMarker = hadCredentials ? "/[credentials-redacted]" : "";
      const queryMarker = hadQuery ? "?credentials-redacted" : "";
      return `${url.protocol}//${url.host}${credentialMarker}${url.pathname}${queryMarker}`;
    } catch {
      return "[url-redacted]";
    }
  });
}

export function sanitizeErrorMessage(value: unknown, maximumLength = 2_048): string {
  const raw = value instanceof Error ? value.message : String(value);
  const withoutControls = [...redactSensitiveUrls(raw)]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("")
    .trim();
  return (withoutControls || "Unknown error").slice(0, maximumLength);
}
