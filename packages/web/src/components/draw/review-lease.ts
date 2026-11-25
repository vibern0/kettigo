export type ReviewLease = Readonly<{
  begin: (owner: symbol, cancel: () => void) => boolean;
  ready: (owner: symbol, cancel: () => void) => boolean;
  confirm: (owner: symbol) => boolean;
  complete: (owner: symbol) => void;
  release: (owner: symbol) => void;
  dispose: () => void;
}>;

type ActiveReview = { owner: symbol; cancel: () => void; confirming: boolean };

// A DrawPage-scoped lease keeps one unused review replaceable without ever
// cancelling an operation once its Confirm handler has taken ownership.
export function createReviewLease(): ReviewLease {
  let active: ActiveReview | undefined;

  function replace(owner: symbol, cancel: () => void) {
    if (active?.confirming) return false;
    active?.cancel();
    active = { owner, cancel, confirming: false };
    return true;
  }

  return {
    begin: replace,
    ready: (owner, cancel) => {
      if (!active || active.owner !== owner || active.confirming) return false;
      active.cancel = cancel;
      return true;
    },
    confirm: (owner) => {
      if (!active || active.owner !== owner || active.confirming) return false;
      active.confirming = true;
      return true;
    },
    complete: (owner) => {
      if (active?.owner === owner) active = undefined;
    },
    release: (owner) => {
      if (active?.owner === owner && !active.confirming) active = undefined;
    },
    dispose: () => {
      if (!active?.confirming) active?.cancel();
      active = undefined;
    },
  };
}
