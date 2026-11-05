import { fireEvent, render, screen } from "@testing-library/react";
import { entryPoint07Address } from "viem/account-abstraction";
import DrawPage from "@/app/draw/page";
import { ActionCenterProvider, useActionCenter } from "@/components/ActionCenter";
import { ToastProvider } from "@/components/Toast";

function ActionProbe() {
  const { actions } = useActionCenter();
  return <output data-testid="actions">{JSON.stringify(actions)}</output>;
}

export function mountPrizeHistory() {
  return render(
    <ToastProvider>
      <ActionCenterProvider>
        <DrawPage />
        <ActionProbe />
      </ActionCenterProvider>
    </ToastProvider>,
  );
}

export async function preparePrizeCheck() {
  mountPrizeHistory();
  await screen.findByText("Your past results");
  fireEvent.change(screen.getByRole("spinbutton", { name: "Round number" }), {
    target: { value: "12" },
  });
  fireEvent.click(screen.getByRole("button", { name: "View round" }));
  fireEvent.click(await screen.findByRole("button", { name: "Review check" }));
  return screen.findByRole("button", { name: "Confirm" });
}

export async function viewPrizeRound() {
  await screen.findByText("Your past results");
  fireEvent.change(screen.getByRole("spinbutton", { name: "Round number" }), {
    target: { value: "12" },
  });
  fireEvent.click(screen.getByRole("button", { name: "View round" }));
}

export function savedPrizeIntent({
  account,
  drawId = 12n,
  pool,
}: {
  account: `0x${string}`;
  drawId?: bigint;
  pool: `0x${string}`;
}) {
  return {
    chainId: 11155111 as const,
    pool,
    account,
    drawId,
    action: "checkPrize" as const,
    operation: {
      chainId: 11155111 as const,
      entryPoint: entryPoint07Address,
      sender: account,
      userOperationHash: `0x${"e".repeat(64)}` as const,
    },
  };
}
