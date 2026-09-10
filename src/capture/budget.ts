/**
 * The per-run capture ledger.
 *
 * 🔑 **Asked BEFORE the capture is made, and that is the whole point.** A
 * budget checked afterwards is a report: the page is already fetched, already
 * posted and already stored, and the number only says how far past the line the
 * run went. `request()` is therefore the thing that spends, not a predicate a
 * caller may ignore.
 *
 * ⚠️ **Counted in captures, not in requests or bytes.** The gateway's quota is
 * a count of stored artefacts, so anything else here would be a second unit
 * that has to be converted — and a conversion is a place for the two to
 * disagree about whether a budget was kept.
 *
 * Pure and separate from the capturer because this is the rule an operator
 * argues about, and it is worth varying without a network or a gateway.
 */

export type BudgetAnswer =
  | { readonly kind: "allowed" }
  /** The run has spent its budget. Distinct from never having had one. */
  | { readonly kind: "exhausted"; readonly limit: number }
  /** No captures were asked for at all. */
  | { readonly kind: "disabled" };

export class CaptureBudget {
  private used = 0;

  constructor(
    private readonly limit: number,
    private readonly enabled: boolean,
  ) {}

  /**
   * Take one capture from the budget, or say why not.
   *
   * ⚠️ Not idempotent, deliberately. It is the spend.
   */
  request(): BudgetAnswer {
    if (!this.enabled) return { kind: "disabled" };
    if (this.used >= this.limit) {
      return { kind: "exhausted", limit: this.limit };
    }
    this.used += 1;
    return { kind: "allowed" };
  }

  /**
   * Hand a capture back when it never happened.
   *
   * 🔑 Called when the *upload* failed, not when the page could not be read: a
   * capture the gateway never received consumed no storage, so charging the run
   * for it would let a bad half-hour of gateway 500s silently eat a whole
   * organization's quota and skip evidence for the items that came after.
   *
   * ⚠️ A failed capture is still **recorded** as `failed` — refunding the
   * budget is not the same as pretending it did not happen.
   */
  refund(): void {
    if (this.used > 0) this.used -= 1;
  }

  get spent(): number {
    return this.used;
  }

  get remaining(): number {
    return this.enabled ? Math.max(this.limit - this.used, 0) : 0;
  }
}
