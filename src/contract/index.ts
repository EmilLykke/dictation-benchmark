/**
 * The benchmark-v2 contract, **mirrored** from `codictate/benchmarks/contract/`.
 *
 * ## Which of the two routes SPEC §7 allows this is, and why
 *
 * SPEC §7 lets the external harness either **import** the canonical modules out of
 * the required sibling Codictate checkout or **re-implement** them and prove
 * byte-identical behaviour against the golden fixtures. **This is the
 * re-implementation route.** The import route was tried first and it does resolve -
 * `import { fingerprintV2 } from "../../codictate/benchmarks/contract/index"`
 * type-checks under this repository's `moduleResolution: "Bundler"` and returns
 * `223d0698c3a11acc` for the empty case - so the reason is not module resolution. It
 * is these three, in order of how much damage each one does:
 *
 * 1. **The Codictate checkout is a runtime value; an import is static.** Every entry
 *    point here takes `--codictate <path>` and carries it as `config.codictatePath`
 *    (`src/portable-paths.ts`), because a committed run record must not name the
 *    machine that produced it and a resume has to be able to point the placeholder at
 *    a different checkout. A static `../../codictate` import would bind the *contract
 *    code* to one checkout while the *audio and the manifests* came from another, and
 *    nothing on disk would record the disagreement. A fingerprint computed by one
 *    checkout's algorithm over another checkout's clips is exactly the failure the
 *    fingerprint exists to catch, dressed as agreement.
 * 2. **`bun test` and `tsc --noEmit` must pass on this repository alone.** The
 *    sibling checkout is a *benchmarking* prerequisite, not a build one: every test
 *    that needs real corpus files is already `describe.skipIf(!existsSync(...))` or a
 *    `.manual.ts` file. A static cross-repository import would make type-checking a
 *    fresh clone impossible, which turns a missing optional dependency into a red
 *    gate.
 * 3. **The canonical module moves, and a mirror pins the version this harness was
 *    tested against.** It moved twice while this directory was being written: SPEC
 *    addendum §D turned `poolSamples` from a throwing per-clip guard into a
 *    compatibility bucketing, and §Q/§R replaced the flat `PoolResult` with buckets and
 *    made the §L speed filter regime-aware (`timing.ts::speedCompatible`). An import
 *    would have moved this repository's *behaviour* underneath a green test run; a
 *    mirror moves only when someone re-copies it and re-runs the parity tests, which is
 *    the point at which the change is looked at.
 *
 * ## How byte-identity is proved rather than asserted
 *
 * - `tests/fixtures/fingerprint-v2.json` is a **verbatim** copy of
 *   `codictate/benchmarks/contract/fixtures/fingerprint-v2.json`
 *   (sha256 `4248a2bf701ae6b9...`, checked equal at copy time). `tests/contract.test.ts`
 *   asserts every case in it. The expected values are never recomputed here: a fixture
 *   that regenerates itself cannot detect a parity bug, which is the one thing it is
 *   for.
 * - `tests/contract-mirror.test.ts` **byte-compares every file in this directory
 *   against the canonical one**, checks the module list and the runtime export sets in
 *   both directions, and pins the seven fingerprint literals in its own source
 *   independently of the fixture. It runs in CI. When the sibling checkout is genuinely
 *   absent it says so on stdout and still asserts the literals, rather than reporting
 *   green vacuously. It caught a real drift the first time it ran: the canonical module
 *   had gained `poolableSpeedTotals` since this directory was last copied.
 * - `tests/contract-parity.manual.ts` additionally compares *behaviour* - same inputs
 *   through both implementations - which is a different question from same bytes. It is
 *   a `.manual.ts` file for the same reason the corpus tests are, and it is no longer
 *   the only thing standing between a drift and a green suite.
 *
 * ## Rules for editing anything in this directory
 *
 * Nothing here may be "improved". Every function is a mirror of a named canonical
 * export, and a change that is not also made in `codictate/benchmarks/contract/`
 * forks the archive. If a rule needs to change, change
 * `codictate/docs/BENCHMARK_CONTRACT.md` and the canonical module first, then mirror
 * it here, then re-run the two tests above.
 */

export {
  assertUniqueClipIds,
  clipIdFromAbsoluteAudioPath,
  clipIdFromRelativeAudioPath,
  fleursClipId,
  FLEURS_SPLIT,
  librispeechClipId,
  uniqueInOrder,
} from "./clip-identity";

export {
  assertRunRecordAgreesWithPlan,
  FINGERPRINT_VERSION,
  fingerprintV2,
  fingerprintV2Matches,
  fingerprintV2Record,
  isCompletedRunRecordV2,
  isFingerprintV2,
  isRunPlanRefV2,
  isRunRecordV2,
  isRunStatus,
  isSampleMeasurementV2,
  isSampleStatus,
  isScoredSample,
  isSuccessfulSample,
  normalizeRunRecordV2,
  RUN_STATUSES,
  SAMPLE_STATUSES,
  SCHEMA_VERSION,
  SCHEMA_VERSION_KEY,
  type FingerprintV2,
  type RunPlanRefV2,
  type RunRecordV2,
  type RunStatus,
  type SampleMeasurementV2,
  type SampleOverheadV2,
  type SampleStatus,
} from "./schema";

export {
  assertNoOverlappingIncompleteRun,
  assertResumeFlags,
  buildRunPlan,
  assertRunPlanOnDisk,
  contiguousCursor,
  isRunPlan,
  maxMeasuredEnd,
  overlappingClipIds,
  overlaps,
  RESUME_FORBIDDEN_FLAGS,
  resumeSelection,
  runPlanComplaints,
  runPlanRef,
  type BuildRunPlanInput,
  type IncompleteRunRef,
  type ResumeForbiddenFlag,
  type ResumeSelection,
  type RunPlan,
} from "./selection";

export {
  compatibilityKey,
  median,
  p90,
  percentileNearestRank,
  pooledCer,
  pooledInferenceRtf,
  pooledSampleCount,
  pooledSpeed,
  pooledWer,
  poolSamples,
  seriesSamples,
  type AccuracyLeafV2,
  type PoolBucket,
  type PooledAccuracy,
  type PooledInferenceRtf,
  type PooledSample,
  type PoolResult,
  type PoolSkipReason,
  type ReplacedSample,
  type SkippedRun,
  type SpeedSummary,
} from "./aggregation";

export {
  HOTKEY_EDGE_KEYDOWN,
  INSTRUMENTATION_ASYMMETRY_LABEL,
  responseMsFromWindow,
  responseMsPerAudioSec,
  speedCompatible,
  stabilityConfirmedAtMs,
  STABILITY_DELAY_MS,
  requiresAsymmetryLabel,
  statedBiasMs,
  TIMING_CLOCK_MONOTONIC,
  TIMING_REGIME_LABELS,
  wallRtfFromResponseRatio,
  type DirectAdapterWindow,
  type SpeedProvenance,
  type TimingRegime,
  type TimingWindow,
  type UiObservation,
  type UiObservedWindow,
} from "./timing";

export {
  HARNESS_CODICTATE,
  HARNESS_WISPR_FLOW,
  isExternalProduct,
  isMeasuringHarness,
  MEASURING_HARNESSES,
  spansBothProducts,
  V1_EXTERNAL_PRODUCT_LABEL,
  type MeasuringHarness,
} from "./harness";

export {
  assertV2OnV1Leaf,
  isV2OnV1Leaf,
  LEAF_SPEED_V2_FIELD,
  poolableSpeedTotals,
  publishableWallRtf,
  V1_FINGERPRINT_FORMATS,
  v2OnV1LeafComplaints,
  type LeafFailuresByStatus,
  type LeafInferenceDiagnostic,
  type LeafSampleRange,
  type LeafSpeedV2,
  type V2OnV1Leaf,
} from "./v1-leaf";
