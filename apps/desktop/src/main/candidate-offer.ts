import { previewToCandidate, type BackendSupervisor } from "@work-intelligence/desktop-core";
import type { StorageRiskService } from "./storage-risk.js";
import type { ShellState } from "./state.js";

export interface CandidateOfferDeps {
  readonly state: ShellState;
  readonly supervisor: BackendSupervisor;
  readonly storage: StorageRiskService;
}

/**
 * Adds a database the user chose to the repair page's candidates: a read-only preview by a separate short-lived child and
 * the storage verdict (DT-08) run together; nothing is written and the running backend is untouched. Returns the id.
 */
export async function offerCandidate(deps: CandidateOfferDeps, path: string): Promise<string> {
  const id = deps.state.candidates.add(path);
  const [preview, risk] = await Promise.all([deps.supervisor.preview(path), deps.storage.classify(path)]);
  deps.state.candidates.setPreview(id, previewToCandidate(preview));
  deps.state.candidates.setStorageRisk(id, risk.risk);
  return id;
}
