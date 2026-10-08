const MAX_SCAN = 20000

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,8000}?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted jwt]'],
  [/\b(?:sk-ant-|sk-|sk_live_|sk_test_|rk_live_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abprs]-|AKIA|ASIA|AIza|hf_|npm_|SG\.|ya29\.)[A-Za-z0-9_.-]{12,}/g, '[redacted token]'],
  [/\b(Authorization(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?(?:Bearer|Basic|Token)\s+)[^\s"'\\]{6,}/gi, '$1[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [redacted]'],
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]+:)[^\s@/]+@/gi, '$1[redacted]@'],
  [/((?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|credential|private[_-]?key|access[_-]?key)[A-Za-z0-9_]*(?:\\?["'])?\s*[=:]\s*(?:\\?["'])?)(?=[^\s"'\\&,;]*[A-Za-z])[^\s"'\\&,;]{6,}/gi, '$1[redacted]'],
]

export function redact(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [+${s.length - n} chars]` : s)

// Clip first, then redact: a huge tool argument is never scanned whole.
export const scrub = (s: string, n: number) => clip(redact(s.slice(0, MAX_SCAN)), n)

export const text = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))
