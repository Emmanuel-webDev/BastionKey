import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "BastionKey | Command Center",
  description: "Dark Bento Command Center for Keyless AI Agent Firewall on NEAR Testnet & MPC.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0c0f",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta
          httpEquiv="Content-Security-Policy"
          content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://rpc.testnet.near.org https://rpc.mainnet.near.org https://testnet.rpc.fastnear.com https://archival-rpc.testnet.fastnear.com https://free.rpc.fastnear.com https://*.fastnear.com https://*.near.org https://sepolia.base.org https://*.basescan.org; img-src 'self' data:; font-src 'self' data:; object-src 'none'; base-uri 'self';"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
