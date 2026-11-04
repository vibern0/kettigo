# Membership accounting notes

This is an engineering note for the confidential pool implementation. It is not
product or marketing copy.

## Admission disclosure and timing

Each account without an active membership has a pending encrypted balance and
an encrypted `balance > 0` marker. The pool deliberately makes that marker
publicly decryptable so that any relayer can submit a signed
`finalizeAdmission(account, nonce, positive, proof)` transaction.

Consequently, admission discloses one durable fact for each pending request:
whether the account had a positive balance at the time represented by the
current nonce. It does not disclose the balance amount. A balance mutation
increments the nonce and invalidates an earlier proof.

Deposits are not eligible for the interim weighted draw until the positive
proof is finalized. Pending principal remains withdrawable through the regular
queued-withdrawal flow; a pending withdrawal refreshes the marker/nonce before
the request can be finalized.

## Active and pending liabilities

`encryptedTotalPrincipal()` includes both active and pending principal.
`encryptedPendingAdmissionPrincipal()` is the pending component. The root sum
of `membershipNode(32, 0)` is the active component used by the interim draw.
The invariant is:

```
total principal = active tree root sum + pending admission principal
```

## Morpho scheduling-attempt counter

`morphoPendingDepositCount` is intentionally a **public scheduling-attempt
counter**, not a public accepted-deposit count. It advances when a deposit or
reinvestment path reaches the Morpho batching scheduler, including an encrypted
amount that resolves to zero because the confidential cap/overflow guard
rejected it. The counter cannot be conditionally incremented on an `ebool`
without either branching on encrypted state or disclosing a new acceptance bit.

The authoritative encrypted amount is `encryptedPendingMorphoPrincipal()`.
Keepers may observe a positive scheduling count with a zero encrypted aggregate;
`requestMorphoPrincipalUnwrap` deliberately permits that zero-amount unwrap to
clear the scheduling window. It cannot transfer principal because the aggregate
is zero. Tests cover rejected callbacks and cap-rejected reinvestment to ensure
principal, pool backing, and winnings are unchanged.
