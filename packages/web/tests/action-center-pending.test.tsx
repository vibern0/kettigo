import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const recoverPendingOperation = vi.fn();
const sendTransaction = vi.fn();
const prepareTransaction = vi.fn();
const signTypedData = vi.fn();
const session = {
  address: "0x1234567890123456789012345678901234567890",
  getPendingOperation: () => ({
    chainId: 11155111 as const,
    entryPoint: "0x0000000071727De22E5E9d8bAF0edAc6f37da032" as const,
    sender: "0x1234567890123456789012345678901234567890" as const,
    userOperationHash: `0x${"ab".repeat(32)}` as `0x${string}`,
    createdAt: 1_000,
    phase: "attempted" as const,
  }),
  recoverPendingOperation,
  sendTransaction,
  prepareTransaction,
  signTypedData,
};

vi.mock("@/lib/wallet-context", () => ({ useWallet: () => ({ session }) }));

import { ActionCenterProvider } from "@/components/ActionCenter";

describe("ActionCenter pending operation", () => {
  it("checks the exact pending operation without sending another action", async () => {
    recoverPendingOperation.mockResolvedValue({
      state: "pending",
      operation: session.getPendingOperation(),
    });
    render(
      <ActionCenterProvider>
        <div>Page content</div>
      </ActionCenterProvider>,
    );

    await screen.findByRole("button", { name: /activity/i });
    fireEvent.click(screen.getByRole("button", { name: /activity/i }));
    await screen.findAllByText(/Still processing/);
    fireEvent.click(screen.getByRole("button", { name: "Check status" }));

    await waitFor(() => expect(recoverPendingOperation).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText(/Still processing/).length).toBeGreaterThan(0);
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(prepareTransaction).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
  });
});
