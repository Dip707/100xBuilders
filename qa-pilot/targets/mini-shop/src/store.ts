export type Product = { id: string; name: string; price: number; description: string };
export type User = { email: string; password: string; name: string };
export type Session = { email: string; cart: Record<string, number>; coupon: string | null };
export type Order = { id: string; email: string; total: number; items: { id: string; qty: number }[] };

export const products: Product[] = [
  { id: "p1", name: "Blue Mug", price: 12, description: "Ceramic mug, 350ml." },
  { id: "p2", name: "Notebook", price: 8, description: "Dotted A5 notebook." },
  { id: "p3", name: "Desk Lamp", price: 35, description: "Warm LED desk lamp." },
];
export const users: User[] = [{ email: "demo@shop.test", password: "demo1234", name: "Demo User" }];
export const sessions = new Map<string, Session>();
export const orders: Order[] = [];

export function newSessionId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
export function cartTotal(s: Session): number {
  let total = 0;
  for (const [id, qty] of Object.entries(s.cart)) {
    const p = products.find((x) => x.id === id);
    if (p) total += p.price * qty;
  }
  if (s.coupon === "SAVE10") total = Math.round(total * 0.9 * 100) / 100;
  return total;
}
