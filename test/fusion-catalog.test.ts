import assert from "node:assert/strict";
import test from "node:test";
import { MAX_FALLBACK_MODELS, MAX_FUSION_PARTICIPANTS, selectCatalogModels } from "../src/fusion/index.js";

const unifiedCatalog = [{ selector: "openai-codex/gpt-test" }, { selector: "anthropic/claude-test" }, { selector: "neuralwatt/cloud-test" }];

test("catalog selection accepts mixed OMP and Neuralwatt participants and deduplicates stably", () => {
  const selected = selectCatalogModels(["neuralwatt/cloud-test", "openai-codex/gpt-test", "neuralwatt/cloud-test", "anthropic/claude-test"], unifiedCatalog, {
    label: "Fusion/MoA participants",
    minimum: 2,
    maximum: MAX_FUSION_PARTICIPANTS,
  });
  assert.deepEqual(selected, ["neuralwatt/cloud-test", "openai-codex/gpt-test", "anthropic/claude-test"]);
});

test("catalog selection rejects unavailable selectors and excessive distinct fallback routes", () => {
  assert.throws(
    () =>
      selectCatalogModels(["provider/\u001b[31mhostile"], [{ selector: "provider/\u001b[31mhostile" }], {
        label: "Fallback",
        minimum: 1,
        maximum: MAX_FALLBACK_MODELS,
      }),
    /invalid selector/,
  );
  assert.throws(
    () =>
      selectCatalogModels(["unknown/model"], unifiedCatalog, {
        label: "Fallback",
        minimum: 1,
        maximum: MAX_FALLBACK_MODELS,
      }),
    /unavailable.*unknown\/model/,
  );

  const many = Array.from({ length: MAX_FALLBACK_MODELS + 1 }, (_, index) => `provider/model-${index}`);
  const catalog = many.map((selector) => ({ selector }));
  assert.throws(
    () =>
      selectCatalogModels(many, catalog, {
        label: "Fallback",
        minimum: 1,
        maximum: MAX_FALLBACK_MODELS,
      }),
    /1-8 distinct model/,
  );
});
