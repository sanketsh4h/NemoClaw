// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for #1980: `nemoclaw <name> rebuild` previously wiped
 * the registry entry (including `policies` and `policyTier`) before invoking
 * `onboard --resume`, so user-customized presets were silently replaced
 * with the tier defaults whenever the sandbox was rebuilt.
 *
 * The fix adds two helpers in src/lib/sandbox-state.ts:
 *   - capturePolicySnapshot(sandboxName)  → { policies, policyTier }
 *   - restorePolicyPresets(sandboxName, snapshot)
 *
 * sandboxRebuild captures the snapshot before the registry wipe and applies
 * the diff after onboard recreates the sandbox.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

describe("sandbox-state policy snapshot helpers", () => {
  let sandboxState;
  let registry;
  let policies;

  beforeEach(() => {
    sandboxState = require("../dist/lib/sandbox-state.js");
    registry = require("../dist/lib/registry.js");
    policies = require("../dist/lib/policies.js");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("capturePolicySnapshot", () => {
    it("returns the policies array and policyTier from the registry entry", () => {
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "test-sandbox",
        policies: ["telegram", "npm", "pypi"],
        policyTier: "balanced",
      });

      const snapshot = sandboxState.capturePolicySnapshot("test-sandbox");

      expect(snapshot.policies).toEqual(["telegram", "npm", "pypi"]);
      expect(snapshot.policyTier).toBe("balanced");
    });

    it("returns a defensive copy of the policies array (not a live reference)", () => {
      const livePolicies = ["telegram"];
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "test-sandbox",
        policies: livePolicies,
        policyTier: "balanced",
      });

      const snapshot = sandboxState.capturePolicySnapshot("test-sandbox");
      livePolicies.push("npm");

      expect(snapshot.policies).toEqual(["telegram"]);
    });

    it("returns an empty snapshot when the sandbox is not in the registry", () => {
      vi.spyOn(registry, "getSandbox").mockReturnValue(null);

      const snapshot = sandboxState.capturePolicySnapshot("missing");

      expect(snapshot.policies).toEqual([]);
      expect(snapshot.policyTier).toBeNull();
    });

    it("tolerates a registry entry with no policies/policyTier fields", () => {
      vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "test-sandbox" });

      const snapshot = sandboxState.capturePolicySnapshot("test-sandbox");

      expect(snapshot.policies).toEqual([]);
      expect(snapshot.policyTier).toBeNull();
    });
  });

  describe("restorePolicyPresets", () => {
    it("re-applies every preset in the snapshot that is not currently applied", () => {
      vi.spyOn(policies, "getAppliedPresets").mockReturnValue([]);
      const applySpy = vi
        .spyOn(policies, "applyPreset")
        .mockReturnValue(true);
      vi.spyOn(policies, "removePreset").mockReturnValue(true);
      vi.spyOn(registry, "updateSandbox").mockImplementation(() => {});

      const result = sandboxState.restorePolicyPresets("test-sandbox", {
        policies: ["telegram", "npm"],
        policyTier: "balanced",
      });

      expect(applySpy).toHaveBeenCalledWith("test-sandbox", "telegram");
      expect(applySpy).toHaveBeenCalledWith("test-sandbox", "npm");
      expect(result.reapplied).toEqual(["telegram", "npm"]);
      expect(result.failed).toEqual([]);
    });

    it("does not re-apply presets that are already applied (idempotent)", () => {
      vi.spyOn(policies, "getAppliedPresets").mockReturnValue(["telegram"]);
      const applySpy = vi
        .spyOn(policies, "applyPreset")
        .mockReturnValue(true);
      vi.spyOn(policies, "removePreset").mockReturnValue(true);
      vi.spyOn(registry, "updateSandbox").mockImplementation(() => {});

      const result = sandboxState.restorePolicyPresets("test-sandbox", {
        policies: ["telegram", "npm"],
        policyTier: "balanced",
      });

      expect(applySpy).toHaveBeenCalledTimes(1);
      expect(applySpy).toHaveBeenCalledWith("test-sandbox", "npm");
      expect(result.reapplied).toEqual(["npm"]);
    });

    it("removes presets that are currently applied but missing from the snapshot", () => {
      vi.spyOn(policies, "getAppliedPresets").mockReturnValue([
        "telegram",
        "huggingface",
        "brew",
      ]);
      vi.spyOn(policies, "applyPreset").mockReturnValue(true);
      const removeSpy = vi
        .spyOn(policies, "removePreset")
        .mockReturnValue(true);
      vi.spyOn(registry, "updateSandbox").mockImplementation(() => {});

      const result = sandboxState.restorePolicyPresets("test-sandbox", {
        policies: ["telegram"],
        policyTier: "restricted",
      });

      expect(removeSpy).toHaveBeenCalledWith("test-sandbox", "huggingface");
      expect(removeSpy).toHaveBeenCalledWith("test-sandbox", "brew");
      expect(removeSpy).not.toHaveBeenCalledWith("test-sandbox", "telegram");
      expect(result.removed.sort()).toEqual(["brew", "huggingface"]);
    });

    it("restores the policyTier in the registry when the snapshot has one", () => {
      vi.spyOn(policies, "getAppliedPresets").mockReturnValue([]);
      vi.spyOn(policies, "applyPreset").mockReturnValue(true);
      vi.spyOn(policies, "removePreset").mockReturnValue(true);
      const updateSpy = vi
        .spyOn(registry, "updateSandbox")
        .mockImplementation(() => {});

      sandboxState.restorePolicyPresets("test-sandbox", {
        policies: [],
        policyTier: "open",
      });

      expect(updateSpy).toHaveBeenCalledWith("test-sandbox", { policyTier: "open" });
    });

    it("does not call updateSandbox when the snapshot has no policyTier", () => {
      vi.spyOn(policies, "getAppliedPresets").mockReturnValue([]);
      vi.spyOn(policies, "applyPreset").mockReturnValue(true);
      vi.spyOn(policies, "removePreset").mockReturnValue(true);
      const updateSpy = vi
        .spyOn(registry, "updateSandbox")
        .mockImplementation(() => {});

      sandboxState.restorePolicyPresets("test-sandbox", {
        policies: [],
        policyTier: null,
      });

      expect(updateSpy).not.toHaveBeenCalled();
    });

    it("records presets that fail to re-apply in the `failed` list", () => {
      vi.spyOn(policies, "getAppliedPresets").mockReturnValue([]);
      vi.spyOn(policies, "applyPreset").mockImplementation((_sb, name) => {
        if (name === "telegram") return false;
        return true;
      });
      vi.spyOn(policies, "removePreset").mockReturnValue(true);
      vi.spyOn(registry, "updateSandbox").mockImplementation(() => {});

      const result = sandboxState.restorePolicyPresets("test-sandbox", {
        policies: ["telegram", "npm"],
        policyTier: "balanced",
      });

      expect(result.reapplied).toEqual(["npm"]);
      expect(result.failed).toEqual(["telegram"]);
    });

    it("does not throw when applyPreset throws for a single preset", () => {
      vi.spyOn(policies, "getAppliedPresets").mockReturnValue([]);
      vi.spyOn(policies, "applyPreset").mockImplementation((_sb, name) => {
        if (name === "telegram") throw new Error("openshell unreachable");
        return true;
      });
      vi.spyOn(policies, "removePreset").mockReturnValue(true);
      vi.spyOn(registry, "updateSandbox").mockImplementation(() => {});

      const result = sandboxState.restorePolicyPresets("test-sandbox", {
        policies: ["telegram", "npm"],
        policyTier: "balanced",
      });

      expect(result.reapplied).toEqual(["npm"]);
      expect(result.failed).toEqual(["telegram"]);
    });

    it("is a no-op when the snapshot has no policies and no tier", () => {
      const getAppliedSpy = vi
        .spyOn(policies, "getAppliedPresets")
        .mockReturnValue([]);
      const applySpy = vi
        .spyOn(policies, "applyPreset")
        .mockReturnValue(true);
      const removeSpy = vi
        .spyOn(policies, "removePreset")
        .mockReturnValue(true);
      const updateSpy = vi
        .spyOn(registry, "updateSandbox")
        .mockImplementation(() => {});

      const result = sandboxState.restorePolicyPresets("test-sandbox", {
        policies: [],
        policyTier: null,
      });

      expect(applySpy).not.toHaveBeenCalled();
      expect(removeSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
      expect(result).toEqual({ reapplied: [], removed: [], failed: [] });
      expect(getAppliedSpy).toHaveBeenCalled();
    });
  });
});
