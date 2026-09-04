const WHISPER_ARTIFACTS_RE =
  /\[BLANK_AUDIO\]|\(music\)|\[silence\]|\[music\]|\[MUSIC\]|\[applause\]|\[Applause\]|\[laughter\]|\[Laughter\]/gi;

export interface WerResult {
  wer: number;
  substitutions: number;
  insertions: number;
  deletions: number;
  refWords: number;
}

export interface CerResult {
  cer: number;
  substitutions: number;
  insertions: number;
  deletions: number;
  refChars: number;
}

interface EditOps {
  substitutions: number;
  insertions: number;
  deletions: number;
}

export function normalizeForWer(text: string): string {
  return text
    .replace(WHISPER_ARTIFACTS_RE, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function computeWer(reference: string, hypothesis: string): WerResult {
  const ref = normalizeForWer(reference).split(" ").filter(Boolean);
  const hyp = normalizeForWer(hypothesis).split(" ").filter(Boolean);
  const result = levenshteinOps(ref, hyp);
  const errorCount = edits(result);
  return {
    ...result,
    wer: ref.length === 0 ? (hyp.length === 0 ? 0 : 1) : errorCount / ref.length,
    refWords: ref.length,
  };
}

export function normalizeForCer(text: string): string {
  return text.replace(WHISPER_ARTIFACTS_RE, "").trim();
}

export function computeCer(reference: string, hypothesis: string): CerResult {
  const ref = [...normalizeForCer(reference)];
  const hyp = [...normalizeForCer(hypothesis)];
  const result = levenshteinOps(ref, hyp);
  const errorCount = edits(result);
  return {
    ...result,
    cer: ref.length === 0 ? (hyp.length === 0 ? 0 : 1) : errorCount / ref.length,
    refChars: ref.length,
  };
}

function levenshteinOps(ref: string[], hyp: string[]): EditOps {
  const rows: EditOps[][] = Array.from({ length: ref.length + 1 }, () => []);

  rows[0][0] = { substitutions: 0, insertions: 0, deletions: 0 };
  for (let i = 1; i <= ref.length; i++) {
    rows[i][0] = { substitutions: 0, insertions: 0, deletions: i };
  }
  for (let j = 1; j <= hyp.length; j++) {
    rows[0][j] = { substitutions: 0, insertions: j, deletions: 0 };
  }

  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) {
      if (ref[i - 1] === hyp[j - 1]) {
        rows[i][j] = { ...rows[i - 1][j - 1] };
        continue;
      }
      const sub = rows[i - 1][j - 1];
      const del = rows[i - 1][j];
      const ins = rows[i][j - 1];
      const subCost = edits(sub) + 1;
      const delCost = edits(del) + 1;
      const insCost = edits(ins) + 1;

      if (subCost <= delCost && subCost <= insCost) {
        rows[i][j] = { ...sub, substitutions: sub.substitutions + 1 };
      } else if (delCost <= insCost) {
        rows[i][j] = { ...del, deletions: del.deletions + 1 };
      } else {
        rows[i][j] = { ...ins, insertions: ins.insertions + 1 };
      }
    }
  }

  return rows[ref.length][hyp.length];
}

function edits(value: EditOps): number {
  return value.substitutions + value.insertions + value.deletions;
}
