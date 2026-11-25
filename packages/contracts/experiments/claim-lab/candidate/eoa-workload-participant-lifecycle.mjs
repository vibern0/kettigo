import { addParticipantDeposit } from "./eoa-workload-stages.mjs";

const principal = (index) => (index === 0 ? "3000000" : index === 1 ? "1000000" : "2000000");

export function addParticipantLifecycle(add, call, definition) {
  for (let index = 0; index < 32; index += 1)
    addParticipantDeposit(
      add,
      call,
      definition,
      index,
      principal(index),
      index === 0
        ? ["initial-batch-finalize-safe", "safe-exit-membership"]
        : index < 7
          ? ["safe-rejoin-admission", "safe-reinvest"]
          : [
              "close-draw-8",
              "safe-stage-8-check",
              ...Array.from(
                { length: 7 },
                (_, member) => `check-stage8-eoa-${String(member).padStart(2, "0")}`,
              ),
            ],
      index === 0 ? "slot-0" : index < 7 ? "stage-8" : "stage-33",
    );
}
