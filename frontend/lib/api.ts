/**
 * Typed API client for the GenAI Customer Simulator backend.
 * All routes map 1:1 to the FastAPI spec.
 */

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type DistributionConfig = Record<string, unknown>;

export interface AudienceExportBundle {
  version: string
  exported_at?: string
  audience: { name: string; description?: string; backstory_prompt_template?: string }
  variables: { name: string; var_type: 'continuous' | 'categorical'; distribution: DistributionConfig; sort_order: number }[]
  correlations: { var_a_name: string; var_b_name: string; correlation: number }[]
  personas: { traits_json: Record<string, unknown>; backstory?: string; plausibility?: number; flagged: boolean }[]
}

export interface ExperimentProtocolBundle {
  version: string
  exported_at?: string
  experiment: {
    name: string
    global_context: string
    execution_mode: 'pooled' | 'dedicated'
  }
  variables: { placeholder: string; attributes: { value: string; weight: number }[] }[]
  dist_variables: { name: string; var_type: string; distribution: Record<string, unknown>; sort_order: number }[]
  questions: {
    sort_order: number
    question_type: 'scale' | 'multiple_choice' | 'open_ended'
    question_text: string
    scale_min?: number
    scale_max?: number
    choices?: string[]
    ask_why: boolean
    prompting_mode?: string
  }[]
  output_schema: { key: string; type: string; description?: string }[]
}

export interface ExperimentImportResult {
  experiment_id: string
  name: string
  variables_imported: number
  dist_variables_imported: number
  questions_imported: number
  output_schema_imported: boolean
}

export interface AudienceImportResult {
  audience_id: string
  name: string
  variables_imported: number
  correlations_imported: number
  personas_imported: number
}

export interface AudienceVariable {
  id: string; audience_id: string; name: string;
  var_type: "continuous" | "categorical" | "ordinal"; distribution: DistributionConfig; sort_order: number;
}
export interface Audience {
  id: string; name: string; description?: string;
  backstory_prompt_template?: string;
  created_at: string; updated_at: string; variables: AudienceVariable[];
  persona_count?: number;
}
export interface Persona {
  id: string; audience_id: string; traits_json: Record<string, unknown>;
  backstory?: string; plausibility?: number; flagged: boolean; created_at: string;
}
export interface SamplingJob {
  id: string; audience_id: string; status: string;
  n_requested: number; n_completed: number;
  backstory_mode: string; validate_plausibility: boolean; llm_validation: boolean;
  created_at: string; completed_at?: string; error?: string;
}
export interface ExperimentDistVariable {
  id: string; experiment_id: string; name: string;
  var_type: "continuous" | "categorical"; distribution: DistributionConfig; sort_order: number;
}
export interface Experiment {
  id: string; audience_id: string; name: string; global_context: string;
  execution_mode: "pooled" | "dedicated";
  drift_detection_enabled: boolean;
  created_at: string;
  variables: ExperimentVariable[]; dist_variables: ExperimentDistVariable[];
  questions: Question[]; output_schemas: OutputSchema[];
}
export interface ExperimentVariable {
  id: string; experiment_id: string; placeholder: string;
  attributes: { value: string; weight: number }[];
}
export interface Question {
  id: string; experiment_id: string; sort_order: number;
  question_type: "scale" | "multiple_choice" | "open_ended";
  question_text: string; scale_min?: number; scale_max?: number;
  choices?: string[]; ask_why: boolean; prompting_mode?: string;
}
export interface OutputSchema { id: string; experiment_id: string; schema_json: SchemaField[]; version: number; created_at: string; }
export interface SchemaField { key: string; type: string; description?: string; }

export interface SimulationRun {
  id: string; experiment_id: string; model_pass1: string; model_pass2: string;
  status: string; total_tasks: number; completed_tasks: number;
  failed_tasks: number; total_cost_usd: number;
  created_at: string; completed_at?: string;
}
export interface SimulationTaskSummary {
  id: string; run_id: string; persona_id: string; injected_vars: Record<string, unknown>;
  pass1_status: string; pass2_status: string; drift_flagged: boolean;
  pass1_cost_usd?: number; pass2_cost_usd?: number;
}
export interface SimulationTaskDetail extends SimulationTaskSummary {
  pass1_prompt?: string; raw_transcript?: string;
  pass1_tokens_in?: number; pass1_tokens_out?: number; pass1_error?: string;
  drift_scores?: number[];
  extracted_json?: Record<string, unknown>;
  extraction_confidence?: Record<string, number>;
  extraction_disagreements?: Record<string, unknown>;
  pass2_tokens_in?: number; pass2_tokens_out?: number; pass2_error?: string;
}

export interface PreflightReport {
  payloads: PersonaPayload[];
  plausibility_summary: { mean_score: number; flagged_count: number; flags: string[][] };
  variable_distributions: Record<string, Record<string, number>>;
  token_estimate: { pass1_input_tokens: number; pass1_output_tokens: number; pass2_input_tokens: number; pass2_output_tokens: number };
  cost_estimate: { pass1_total: number; pass2_total: number; grand_total: number; per_persona: number };
  sample_size: number;
}
export interface PersonaPayload {
  persona_traits: Record<string, unknown>; backstory_preview: string;
  resolved_variables: Record<string, string>; questions: { text: string; type: string; ask_why: boolean }[];
  plausibility: number; flags: string[];
}

export interface PreviewInterviewResult {
  persona_id: string; assembled_prompt: string; transcript: string;
  extracted_json?: Record<string, unknown>; extraction_confidence?: Record<string, number>;
  pass1_tokens_in: number; pass1_tokens_out: number; pass1_cost_usd: number;
}

export interface CalibrationStatus {
  experiment_id: string; level: "uncalibrated" | "directional" | "calibrated";
  last_calibrated?: string; notes?: string;
  benchmarks: { id: string; question_id: string; js_divergence: number; sample_size_real: number; sample_size_synthetic: number; created_at: string }[];
}

// ── Analysis types ────────────────────────────────────────────────────────────

export interface FieldSummaryScale {
  key: string; type: string; description: string; n: number; missing: number;
  mean: number | null; median: number; std: number; min: number; max: number;
  histogram: { label: string; count: number }[];
}
export interface FieldSummaryChoice {
  key: string; type: string; description: string; n: number; missing: number;
  distribution: Record<string, { count: number; pct: number }>;
}
export interface FieldSummaryBoolean {
  key: string; type: string; description: string; n: number; missing: number;
  true_count: number; false_count: number; true_pct: number;
}
export interface FieldSummaryText {
  key: string; type: string; description: string; n: number; missing: number;
  answers: string[];
  llm_summary: string | null;
}
export type FieldSummary = FieldSummaryScale | FieldSummaryChoice | FieldSummaryBoolean | FieldSummaryText;

export interface RunAnalysisSummary {
  run_id: string; experiment_id: string;
  total_tasks: number; completed_tasks: number; drift_flagged_count: number;
  confidence_threshold: number;
  fields: Record<string, FieldSummary>;
}
export interface FieldSummarizeResult { key: string; llm_summary: string; }
export interface DeepDiveResult {
  analysis: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  generated_at: string;
}

export interface ModelPricing { input: number; output: number }

export interface AppSettings {
  // API keys & endpoints (keys never echoed)
  openai_api_key_set: boolean;
  lmstudio_base_url: string;
  anthropic_api_key_set: boolean;

  // Per-step provider ("openai" | "lmstudio" | "anthropic") + model
  provider_pass1: string;
  model_pass1: string;
  provider_pass2: string;
  model_pass2: string;
  provider_backstory: string;       // "" = inherit from pass2
  model_backstory: string;
  effective_backstory_provider: string;
  effective_backstory_model: string;
  provider_validation: string;      // "" = inherit from pass2
  model_validation: string;
  effective_validation_provider: string;
  effective_validation_model: string;

  max_concurrent_tasks: number;
  tpm_limit: number;
  plausibility_threshold: number;
  max_context_tokens: number;
  model_pricing: Record<string, ModelPricing>;
}

// ── API Methods ───────────────────────────────────────────────────────────────

export const api = {
  // Audiences
  createAudience: (body: { name: string; description?: string }) =>
    req<Audience>("POST", "/api/audiences", body),
  listAudiences: () => req<Audience[]>("GET", "/api/audiences"),
  getAudience: (id: string) => req<Audience>("GET", `/api/audiences/${id}`),
  updateAudience: (id: string, body: Partial<{ name: string; description: string; backstory_prompt_template: string | null }>) =>
    req<Audience>("PUT", `/api/audiences/${id}`, body),
  duplicateAudience: (id: string) => req<Audience>("POST", `/api/audiences/${id}/duplicate`),
  deleteAudience: (id: string) => req<void>("DELETE", `/api/audiences/${id}`),

  addVariable: (audienceId: string, body: { name: string; var_type: string; distribution: DistributionConfig; sort_order?: number }) =>
    req<AudienceVariable>("POST", `/api/audiences/${audienceId}/variables`, body),
  updateVariable: (audienceId: string, varId: string, body: Partial<{ name: string; var_type: string; distribution: DistributionConfig; sort_order: number }>) =>
    req<AudienceVariable>("PUT", `/api/audiences/${audienceId}/variables/${varId}`, body),
  deleteVariable: (audienceId: string, varId: string) =>
    req<void>("DELETE", `/api/audiences/${audienceId}/variables/${varId}`),

  getCorrelations: (audienceId: string) =>
    req<{ var_a_id: string; var_b_id: string; correlation: number }[]>("GET", `/api/audiences/${audienceId}/correlations`),
  upsertCorrelations: (audienceId: string, correlations: { var_a_id: string; var_b_id: string; correlation: number }[]) =>
    req<{ status: string; count: number }>("PUT", `/api/audiences/${audienceId}/correlations`, { correlations }),

  addConditionalRule: (audienceId: string, body: unknown) =>
    req<unknown>("POST", `/api/audiences/${audienceId}/conditional-rules`, body),
  deleteConditionalRule: (audienceId: string, ruleId: string) =>
    req<void>("DELETE", `/api/audiences/${audienceId}/conditional-rules/${ruleId}`),

  samplePersonas: (audienceId: string, body: { n: number; validate_plausibility?: boolean; llm_validation?: boolean; reuse_existing?: boolean; backstory_mode?: 'none' | 'template' | 'llm' }) =>
    req<SamplingJob>("POST", `/api/audiences/${audienceId}/sample`, body),
  samplePersonasFresh: (audienceId: string, body: { n: number; validate_plausibility?: boolean; llm_validation?: boolean; backstory_mode?: 'none' | 'template' | 'llm' }) =>
    req<SamplingJob>("POST", `/api/audiences/${audienceId}/sample/fresh`, body),
  listSamplingJobs: (audienceId: string) =>
    req<SamplingJob[]>("GET", `/api/audiences/${audienceId}/sampling-jobs`),
  getSamplingJob: (audienceId: string, jobId: string) =>
    req<SamplingJob>("GET", `/api/audiences/${audienceId}/sampling-jobs/${jobId}`),
  stopSamplingJob: (audienceId: string, jobId: string) =>
    req<SamplingJob>("POST", `/api/audiences/${audienceId}/sampling-jobs/${jobId}/stop`),
  resumeSamplingJob: (audienceId: string, jobId: string) =>
    req<SamplingJob>("POST", `/api/audiences/${audienceId}/sampling-jobs/${jobId}/resume`),
  listPersonas: (audienceId: string) =>
    req<Persona[]>("GET", `/api/audiences/${audienceId}/personas`),
  deletePersona: (audienceId: string, personaId: string) =>
    req<void>("DELETE", `/api/audiences/${audienceId}/personas/${personaId}`),

  exportAudience: (audienceId: string, includePersonas = true): string =>
    `${BASE}/api/audiences/${audienceId}/export?include_personas=${includePersonas}`,
  importAudience: (bundle: AudienceExportBundle) =>
    req<AudienceImportResult>("POST", "/api/audiences/import", bundle),

  // Experiment protocol import / export (no run data — config only)
  exportExperimentProtocol: (expId: string): string =>
    `${BASE}/api/experiments/export-protocol/${expId}`,
  importExperimentProtocol: (audienceId: string, bundle: ExperimentProtocolBundle) =>
    req<ExperimentImportResult>("POST", "/api/experiments/import-protocol", {
      audience_id: audienceId,
      bundle,
    }),

  // Experiments
  createExperiment: (body: { audience_id: string; name: string; global_context?: string; execution_mode?: string }) =>
    req<Experiment>("POST", "/api/experiments", body),
  listExperiments: () => req<Experiment[]>("GET", "/api/experiments"),
  getExperiment: (id: string) => req<Experiment>("GET", `/api/experiments/${id}`),
  updateExperiment: (id: string, body: Partial<Experiment>) =>
    req<Experiment>("PUT", `/api/experiments/${id}`, body),
  deleteExperiment: (id: string) => req<void>("DELETE", `/api/experiments/${id}`),

  addExpVariable: (expId: string, body: { placeholder: string; attributes: { value: string; weight: number }[] }) =>
    req<ExperimentVariable>("POST", `/api/experiments/${expId}/variables`, body),
  updateExpVariable: (expId: string, varId: string, body: unknown) =>
    req<ExperimentVariable>("PUT", `/api/experiments/${expId}/variables/${varId}`, body),
  deleteExpVariable: (expId: string, varId: string) =>
    req<void>("DELETE", `/api/experiments/${expId}/variables/${varId}`),

  addExpDistVariable: (expId: string, body: { name: string; var_type: string; distribution: DistributionConfig; sort_order?: number }) =>
    req<ExperimentDistVariable>("POST", `/api/experiments/${expId}/dist-variables`, body),
  updateExpDistVariable: (expId: string, varId: string, body: Partial<{ name: string; var_type: string; distribution: DistributionConfig; sort_order: number }>) =>
    req<ExperimentDistVariable>("PUT", `/api/experiments/${expId}/dist-variables/${varId}`, body),
  deleteExpDistVariable: (expId: string, varId: string) =>
    req<void>("DELETE", `/api/experiments/${expId}/dist-variables/${varId}`),

  addQuestion: (expId: string, body: Omit<Question, "id" | "experiment_id">) =>
    req<Question>("POST", `/api/experiments/${expId}/questions`, body),
  updateQuestion: (expId: string, qId: string, body: Partial<Question>) =>
    req<Question>("PUT", `/api/experiments/${expId}/questions/${qId}`, body),
  deleteQuestion: (expId: string, qId: string) =>
    req<void>("DELETE", `/api/experiments/${expId}/questions/${qId}`),
  reorderQuestions: (expId: string, order: string[]) =>
    req<{ status: string }>("PUT", `/api/experiments/${expId}/questions/reorder`, { order }),

  createOutputSchema: (expId: string, schema_json: SchemaField[]) =>
    req<OutputSchema>("POST", `/api/experiments/${expId}/output-schema`, { schema_json }),
  getOutputSchema: (expId: string) =>
    req<OutputSchema>("GET", `/api/experiments/${expId}/output-schema`),

  preflight: (expId: string, body: { sample_size?: number; model_pass1?: string; model_pass2?: string; dual_extraction?: boolean }) =>
    req<PreflightReport>("POST", `/api/experiments/${expId}/preflight`, body),

  previewInterview: (expId: string, body: { persona_id: string; model?: string; dual_extraction?: boolean }) =>
    req<PreviewInterviewResult>("POST", `/api/experiments/${expId}/preview-interview`, body),

  // Runs
  listRuns: (experimentId?: string, limit = 50) =>
    req<SimulationRun[]>("GET", `/api/runs?limit=${limit}${experimentId ? `&experiment_id=${experimentId}` : ''}`),
  launchRun: (expId: string, body: { population_size: number; model_pass1?: string; model_pass2?: string; dual_extraction?: boolean; sample_fresh?: boolean; persona_ids?: string[] }) =>
    req<SimulationRun>("POST", `/api/experiments/${expId}/launch`, body),
  getRun: (runId: string) => req<SimulationRun>("GET", `/api/runs/${runId}`),
  getRunProgress: (runId: string) =>
    req<{ p1_running: number; p1_done: number; p2_running: number; p2_done: number; failed: number; total: number }>("GET", `/api/runs/${runId}/progress`),
  listTasks: (runId: string, offset = 0, limit = 50) =>
    req<SimulationTaskSummary[]>("GET", `/api/runs/${runId}/tasks?offset=${offset}&limit=${limit}`),
  getTask: (runId: string, taskId: string) =>
    req<SimulationTaskDetail>("GET", `/api/runs/${runId}/tasks/${taskId}`),
  retryFailed: (runId: string) => req<{ status: string }>("POST", `/api/runs/${runId}/retry-failed`),
  cancelRun: (runId: string) => req<{ status: string }>("POST", `/api/runs/${runId}/cancel`),
  resumeRun: (runId: string) => req<{ status: string }>("POST", `/api/runs/${runId}/resume`),
  reExtract: (runId: string, schema_version?: number) =>
    req<{ status: string }>("POST", `/api/runs/${runId}/re-extract`, { schema_version }),
  exportRun: (runId: string, format: "csv" | "xlsx" = "csv", includeTranscript = false) =>
    `${BASE}/api/runs/${runId}/export?format=${format}&include_transcript=${includeTranscript}`,
  deleteRun: (runId: string) => req<void>("DELETE", `/api/runs/${runId}`),
  pruneRuns: (includeCompleted = false, experimentId?: string) => {
    const params = new URLSearchParams({ include_completed: String(includeCompleted) })
    if (experimentId) params.set('experiment_id', experimentId)
    return req<{ deleted: number }>("DELETE", `/api/runs?${params}`)
  },

  // Analysis
  getRunSummary: (runId: string, confidenceThreshold = 0) =>
    req<RunAnalysisSummary>("GET", `/api/runs/${runId}/analysis/summary?confidence_threshold=${confidenceThreshold}`),
  summarizeField: (runId: string, fieldKey: string, confidenceThreshold = 0) =>
    req<FieldSummarizeResult>("POST", `/api/runs/${runId}/analysis/summarize-field`, { field_key: fieldKey, confidence_threshold: confidenceThreshold }),
  generateDeepDive: (runId: string, confidenceThreshold = 0) =>
    req<DeepDiveResult>("POST", `/api/runs/${runId}/analysis/deep-dive`, { confidence_threshold: confidenceThreshold }),
  getPrompt: (name: string) => req<{ name: string; content: string }>("GET", `/api/analysis/prompts/${name}`),
  updatePrompt: (name: string, content: string) => req<{ name: string; content: string }>("PUT", `/api/analysis/prompts/${name}`, { content }),
  exportAnalysisPdf: (runId: string): string => `${BASE}/api/runs/${runId}/analysis/export-pdf`,

  // Settings
  getSettings: () => req<AppSettings>('GET', '/api/settings'),
  updateSettings: (body: Partial<AppSettings>) => req<AppSettings>('PUT', '/api/settings', body),

  // Calibration
  addCalibrationData: (expId: string, body: { question_id: string; field_key: string; real_responses: unknown[] }) =>
    req<unknown>("POST", `/api/experiments/${expId}/calibrate`, body),
  getCalibration: (expId: string) =>
    req<CalibrationStatus>("GET", `/api/experiments/${expId}/calibration`),
};
