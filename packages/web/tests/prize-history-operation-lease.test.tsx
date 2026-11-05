import { expect, test } from "vitest";
import { entryPoint07Address } from "viem/account-abstraction";
import {
  SafeUserOperationFailedError,
  SafeUserOperationNotSubmittedError,
  SafeUserOperationRejectedError,
} from "@/lib/passkey-operation";
import { drawOperationKey } from "@/components/draw/draw-page-utils";
import { completeKnownPrizeHistoryOperation } from "@/components/draw/prize-history-operation-lease";
import { createReviewLease } from "@/components/draw/review-lease";

const sender = "0x1111111111111111111111111111111111111111" as const;

function operation(hash: string) {
  return {
    chainId: 11155111 as const,
    entryPoint: entryPoint07Address,
    sender,
    userOperationHash: `0x${hash.repeat(64)}` as `0x${string}`,
  };
}

function confirmingLease() {
  const reviewLease = createReviewLease();
  const owner = Symbol("observed");
  expect(reviewLease.begin(owner, () => undefined)).toBe(true);
  expect(reviewLease.ready(owner, () => undefined)).toBe(true);
  expect(reviewLease.confirm(owner)).toBe(true);
  return { owner, reviewLease };
}

test.each([
  (value: ReturnType<typeof operation>) => new SafeUserOperationRejectedError(value, 4001),
  (value: ReturnType<typeof operation>) => new SafeUserOperationNotSubmittedError(value),
  (value: ReturnType<typeof operation>) => new SafeUserOperationFailedError(value),
])("does not unlock an unbound typed terminal operation", (terminal) => {
  const { owner, reviewLease } = confirmingLease();
  completeKnownPrizeHistoryOperation(owner, terminal(operation("a")), new Map(), reviewLease);

  expect(reviewLease.begin(Symbol("competitor"), () => undefined)).toBe(false);
});

test("does not unlock an owner bound to a different observed operation", () => {
  const { owner, reviewLease } = confirmingLease();
  const owners = new Map([[drawOperationKey(operation("a")), owner]]);
  completeKnownPrizeHistoryOperation(
    owner,
    new SafeUserOperationNotSubmittedError(operation("b")),
    owners,
    reviewLease,
  );

  expect(reviewLease.begin(Symbol("competitor"), () => undefined)).toBe(false);
});

test("unlocks only the owner bound to the matching terminal operation", () => {
  const { owner, reviewLease } = confirmingLease();
  const owners = new Map([[drawOperationKey(operation("a")), owner]]);
  completeKnownPrizeHistoryOperation(
    owner,
    new SafeUserOperationNotSubmittedError(operation("a")),
    owners,
    reviewLease,
  );

  expect(reviewLease.begin(Symbol("competitor"), () => undefined)).toBe(true);
});
