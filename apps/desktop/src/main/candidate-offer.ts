import { previewToCandidate, type BackendSupervisor } from "@work-intelligence/desktop-core";
import type { StorageRiskService } from "./storage-risk.js";
import type { ShellState } from "./state.js";

export interface CandidateOfferDeps {
  readonly state: ShellState;
  readonly supervisor: BackendSupervisor;
  readonly storage: StorageRiskService;
}

export async function offerCandidate(deps: CandidateOfferDeps, path: string): Promise<string> {
  const id = deps.state.candidates.add(path);
  const [preview, risk] = await Promise.all([deps.supervisor.preview(path), deps.storage.classify(path)]);
  deps.state.candidates.setPreview(id, previewToCandidate(preview));
  deps.state.candidates.setStorageRisk(id, risk.risk);
  return id;
}
