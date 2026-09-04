export type ChaosState = { renameCheckoutButton: boolean; breakCoupon: boolean; cosmeticChange: boolean };

export const chaos: ChaosState = {
  renameCheckoutButton: process.env.CHAOS_RENAME_CHECKOUT === "1",
  breakCoupon: process.env.CHAOS_BREAK_COUPON === "1",
  cosmeticChange: process.env.CHAOS_COSMETIC === "1",
};

export function setChaos(patch: Partial<ChaosState>): ChaosState {
  for (const k of Object.keys(chaos) as (keyof ChaosState)[]) {
    if (typeof patch[k] === "boolean") chaos[k] = patch[k]!;
  }
  return { ...chaos };
}
