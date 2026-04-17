import { loadStripe, type Stripe, type Appearance } from "@stripe/stripe-js";

let stripePromise: Promise<Stripe | null> | null = null;
let cachedKey = "";

export function getStripePromise(publishableKey: string) {
  if (!stripePromise || cachedKey !== publishableKey) {
    cachedKey = publishableKey;
    stripePromise = loadStripe(publishableKey);
  }
  return stripePromise;
}

// Stripe Elements appearance tuned to the app's neo-brutalist theme.
// Colors mirror tailwind tokens defined in src/web/index.html.
export const stripeAppearance: Appearance = {
  theme: "flat",
  variables: {
    colorPrimary: "#1A1A1A",
    colorBackground: "#FFFFFF",
    colorText: "#1A1A1A",
    colorTextSecondary: "#4A4A4A",
    colorTextPlaceholder: "#8A8A8A",
    colorDanger: "#FF4444",
    colorIconCardError: "#FF4444",
    fontFamily: "'Space Mono', monospace",
    fontSizeBase: "12px",
    fontSizeSm: "11px",
    spacingUnit: "4px",
    borderRadius: "0px",
  },
  rules: {
    ".Label": {
      fontSize: "9px",
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: "0.05em",
      color: "#1A1A1A",
      marginBottom: "6px",
    },
    ".Input": {
      border: "2px solid #1A1A1A",
      backgroundColor: "#FFFFFF",
      padding: "8px 10px",
      fontSize: "11px",
      boxShadow: "none",
      transition: "box-shadow .1s, transform .1s",
    },
    ".Input:focus": {
      border: "2px solid #1A1A1A",
      boxShadow: "2px 2px 0 #1A1A1A",
      transform: "translate(-1px, -1px)",
      outline: "none",
    },
    ".Input--invalid": {
      border: "2px solid #FF4444",
    },
    ".Tab": {
      border: "2px solid #1A1A1A",
      backgroundColor: "#FFFFFF",
      borderRadius: "0px",
      padding: "8px 10px",
    },
    ".Tab:hover": {
      backgroundColor: "#F0EBE1",
    },
    ".Tab--selected": {
      backgroundColor: "#BAFF39",
      boxShadow: "2px 2px 0 #1A1A1A",
    },
    ".Error": {
      fontSize: "10px",
      color: "#FF4444",
      marginTop: "4px",
    },
    ".AccordionItem": {
      border: "2px solid #1A1A1A",
      borderRadius: "0px",
      backgroundColor: "#FFFFFF",
    },
  },
};
