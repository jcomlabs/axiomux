export const MAX_FALLBACK_MODELS = 8;
export const MAX_FUSION_PARTICIPANTS = 8;

export interface CatalogModelLike {
  selector: string;
}

export interface CatalogSelectionOptions {
  label: string;
  minimum: number;
  maximum: number;
}

/**
 * Normalizes a user-facing model list and proves every selector exists in the
 * already merged Axiomux catalog. Order is stable and duplicate entries are
 * deliberately collapsed instead of turning into duplicate provider calls.
 */
export function selectCatalogModels(requested: readonly string[], catalog: readonly CatalogModelLike[], options: CatalogSelectionOptions): string[] {
  if (!Array.isArray(requested)) throw new Error(`${options.label} must be a list of models`);
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const raw of requested) {
    const selector = typeof raw === "string" ? raw.trim() : "";
    if (!isModelSelector(selector)) throw new Error(`${options.label} contains an invalid selector: ${String(raw)}`);
    if (seen.has(selector)) continue;
    seen.add(selector);
    selected.push(selector);
  }
  if (selected.length < options.minimum || selected.length > options.maximum) {
    throw new Error(`${options.label} requires ${options.minimum}-${options.maximum} distinct model(s)`);
  }

  const available = new Set(catalog.map((model) => model.selector));
  const missing = selected.filter((selector) => !available.has(selector));
  if (missing.length) {
    throw new Error(`${options.label} contains model(s) unavailable in the isolated catalog: ${missing.join(", ")}`);
  }
  return selected;
}

export function isModelSelector(value: string): boolean {
  return value.length <= 240 && /^[^\s/]+\/[^\s]{1,220}$/u.test(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
