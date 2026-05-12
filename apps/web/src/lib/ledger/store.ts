import { useLocalStorage } from "../useLocalStorage";
import type { ImportedLedger } from "./types";

const KEY = "capflow.ledger";

export function useLedger() {
  const [state, setState] = useLocalStorage<ImportedLedger | null>(KEY, null);
  return [state, setState] as const;
}
