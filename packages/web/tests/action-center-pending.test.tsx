import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const recoverPendingOperation = vi.fn();
const sendTransaction = vi.fn();
const prepareTransaction = vi.fn();
const signTypedData = vi.fn();
const savedRunner = vi.fn(async () => {
  throw new Error("server secret should never be shown");
});
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

const wallet: { session: any } = { session };
vi.mock("@/lib/wallet-context", () => ({ useWallet: () => wallet }));

import { ActionCenterProvider, useActionCenter } from "@/components/ActionCenter";

function ActionProbe() {
  const { actions, retryTrackedAction, runAction } = useActionCenter();
  return (
    <>
      <output data-testid="actions">{JSON.stringify(actions)}</output>
      <button
        type="button"
        onClick={() => runAction({ label: "Saved action", type: "pending" }, savedRunner)}
      >
        Run action
      </button>
      <button type="button" onClick={() => actions[0] && retryTrackedAction(actions[0].id)}>
        Retry first
      </button>
    </>
  );
}

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

  it("keeps retained activity visible when status recovery is unavailable", async () => {
    const recovery = session.recoverPendingOperation;
    delete (session as { recoverPendingOperation?: typeof recoverPendingOperation })
      .recoverPendingOperation;
    render(
      <ActionCenterProvider>
        <div>Page content</div>
      </ActionCenterProvider>,
    );

    await screen.findByRole("button", { name: /activity/i });
    fireEvent.click(screen.getByRole("button", { name: /activity/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Check status" }));

    expect(await screen.findByText(/Status is unavailable right now/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check status" })).toBeTruthy();
    session.recoverPendingOperation = recovery;
  });

  it("drops a late recovery result after the account changes", async () => {
    let resolve!: (value: unknown) => void;
    recoverPendingOperation.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = render(
      <ActionCenterProvider>
        <ActionProbe />
      </ActionCenterProvider>,
    );
    await screen.findByRole("button", { name: /activity/i });
    fireEvent.click(screen.getByRole("button", { name: /activity/i }));
    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    wallet.session = {
      ...session,
      address: "0x2234567890123456789012345678901234567890",
      getPendingOperation: () => null,
    };
    view.rerender(
      <ActionCenterProvider>
        <ActionProbe />
      </ActionCenterProvider>,
    );
    resolve({
      state: "confirmed",
      operation: session.getPendingOperation(),
      transactionHash: `0x${"cd".repeat(32)}`,
      blockHash: `0x${"ef".repeat(32)}`,
      blockNumber: 1n,
    });
    await waitFor(() =>
      expect(screen.getByTestId("actions").textContent).not.toContain("completed"),
    );
    wallet.session = session;
  });

  it("keeps runner error copy controlled", async () => {
    savedRunner.mockClear();
    wallet.session = {
      ...session,
      getPendingOperation: () => {
        throw new Error("storage secret");
      },
    };
    render(
      <ActionCenterProvider>
        <ActionProbe />
      </ActionCenterProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run action" }));
    await waitFor(() =>
      expect(screen.getByTestId("actions").textContent).toContain("Status is unavailable"),
    );
    expect(screen.getByTestId("actions").textContent).not.toContain("secret");
    fireEvent.click(screen.getByRole("button", { name: "Retry first" }));
    expect(screen.getByTestId("actions").textContent).toContain("confirming");
    wallet.session = session;
  });

  it("retains unavailable activity after reload without replaying its runner", async () => {
    savedRunner.mockClear();
    wallet.session = {
      ...session,
      getPendingOperation: () => {
        throw new Error("storage secret");
      },
    };
    const first = render(
      <ActionCenterProvider>
        <ActionProbe />
      </ActionCenterProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run action" }));
    await waitFor(() =>
      expect(window.localStorage.getItem("kettigo:actions")).toContain("Status is unavailable"),
    );
    first.unmount();

    render(
      <ActionCenterProvider>
        <ActionProbe />
      </ActionCenterProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("actions").textContent).toContain("confirming"));
    fireEvent.click(screen.getByRole("button", { name: "Retry first" }));

    expect(savedRunner).toHaveBeenCalledTimes(1);
    expect(prepareTransaction).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
    expect(screen.getByTestId("actions").textContent).not.toContain("secret");
    wallet.session = session;
  });

  it("keeps legacy activity history readable after hydration", async () => {
    wallet.session = null;
    window.localStorage.setItem(
      "kettigo:actions",
      JSON.stringify([
        {
          id: "legacy",
          label: "Earlier action",
          type: "deposit",
          status: "completed",
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    );
    render(
      <ActionCenterProvider>
        <ActionProbe />
      </ActionCenterProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("actions").textContent).toContain("Earlier action"),
    );
    expect(screen.getByTestId("actions").textContent).not.toContain("operation");
    window.localStorage.removeItem("kettigo:actions");
    wallet.session = session;
  });
});
