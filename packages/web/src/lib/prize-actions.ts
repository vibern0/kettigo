import { formatUSDC } from "./format.ts";

export function getPrizeRevealFeedback(winnings: bigint) {
  if (winnings > 0n) {
    return {
      tone: "success" as const,
      title: "You got a prize!",
      description: `${formatUSDC(winnings, 6)} USDC is ready to claim.`,
      celebration: "prize" as const,
    };
  }
  return {
    tone: "info" as const,
    title: "No prize this time.",
    description: "Your savings are still yours.",
  };
}

export type PrizeActionId = "checkPrize" | "addPrizeToSavings" | "claimPrize";
export type PrizeWorkingAction = PrizeActionId | undefined;

export type PrizeAction = {
  id: PrizeActionId;
  label: string;
  busyLabel: string;
  disabled: boolean;
  variant: "primary" | "secondary";
};

type PrizeActionState = {
  connected: boolean;
  ready: boolean;
  busy: boolean;
  hasPrizeToClaim: boolean;
  workingAction: PrizeWorkingAction;
};

export function getPrizeActions(state: PrizeActionState): PrizeAction[] {
  const baseDisabled = !state.connected || !state.ready || state.busy;
  const actions: PrizeAction[] = state.hasPrizeToClaim
    ? [
        {
          id: "addPrizeToSavings",
          label: "Add prize to savings",
          busyLabel: "Adding...",
          disabled: baseDisabled,
          variant: "primary",
        },
        {
          id: "claimPrize",
          label: "Claim prize",
          busyLabel: "Claiming...",
          disabled: baseDisabled,
          variant: "secondary",
        },
      ]
    : [
        {
          id: "checkPrize",
          label: "Check prize",
          busyLabel: "Checking...",
          disabled: baseDisabled,
          variant: "primary",
        },
      ];

  return actions.map((action) => ({
    ...action,
    label: state.workingAction === action.id ? action.busyLabel : action.label,
  }));
}
