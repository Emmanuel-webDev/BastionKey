import type { ReactNode } from "react";

export const metadata = { title: "BastionKey Command Center" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "#0b0f14",
          color: "#d7e0ea",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        {children}
      </body>
    </html>
  );
}
