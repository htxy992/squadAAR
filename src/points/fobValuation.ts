/**
 * FOB valuation v(t) and destruction multiplier d(t) — documentation §3.2.7.
 *
 *   dv/dt = -v(t)·γ + Σ Δv_i·δ(t - t_i),   v(0) = v0
 *   v(t)  = e^{-γt}[ v0 + Σ e^{γ t_i} Δv_i Θ(t - t_i) ]          (eq. 2)
 *   d(t)  = 1 + 1 / (1 + e^{ v(t) - <v> } )   ∈ [1, 2]            (eq. 3)
 *
 * γ = ln2 / τ with half-life τ. Value rises when players who spawned at the FOB
 * earn points and decays toward zero during inactivity.
 */
export class FobValuation {
  private updates: Array<{ t: number; dv: number }> = [];
  readonly gamma: number;

  /** @param halfLifeMs valuation half-life (default 5 min) */
  constructor(halfLifeMs = 5 * 60 * 1000) {
    this.gamma = Math.log(2) / halfLifeMs;
  }

  /** Record a valuation increase Δv at absolute time t (only positive points count). */
  add(t: number, dv: number): void {
    if (dv > 0) this.updates.push({ t, dv });
  }

  /** Evaluate v(t) per eq. 2. */
  value(t: number): number {
    let acc = 0;
    for (const u of this.updates) {
      if (u.t <= t) acc += Math.exp(this.gamma * u.t) * u.dv;
    }
    return Math.exp(-this.gamma * t) * acc;
  }

  /** Total accumulated raw value (sum of Δv), used for the global mean <v>. */
  totalRaw(): number {
    return this.updates.reduce((s, u) => s + u.dv, 0);
  }

  /** Destruction multiplier d(t) per eq. 3, given the population mean valuation. */
  destructionMultiplier(t: number, meanValue: number): number {
    const v = this.value(t);
    return 1 + 1 / (1 + Math.exp(v - meanValue));
  }
}
